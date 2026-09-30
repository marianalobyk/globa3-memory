import { NextResponse, type NextRequest } from 'next/server';

/**
 * Keeps the Supabase session alive.
 *
 * Supabase access tokens are short-lived. Server Components cannot set cookies,
 * so the refresh has to happen somewhere that can — which is here, before the
 * request reaches a page or a route handler. When the access token is expired
 * or nearly so, the refresh token is exchanged for a new pair, the new pair is
 * written back as httpOnly cookies, and the refreshed access token is forwarded
 * on the request so the handler downstream sees a valid session immediately.
 *
 * This file runs on the Edge runtime, so it deliberately imports nothing from
 * @g3/core: that package pulls in `pg`, which cannot run here. The few constants
 * it needs are duplicated below rather than imported.
 */

const ACCESS_TOKEN_COOKIE = 'g3_at';
const REFRESH_TOKEN_COOKIE = 'g3_rt';

/** Refresh this many seconds before actual expiry, to avoid a race at the edge. */
const REFRESH_SKEW_SECONDS = 60;

function isExpired(token: string): boolean {
  const part = token.split('.')[1];
  if (!part) return true;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { exp?: number };
    if (!claims.exp) return true;
    return claims.exp * 1000 - REFRESH_SKEW_SECONDS * 1000 <= Date.now();
  } catch {
    return true;
  }
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

/**
 * Cross-origin access for the mobile app's web preview during development.
 *
 * The native iOS app is not a browser and needs no CORS. Expo's web preview
 * runs on its own port, so the API must name it explicitly. Only origins listed
 * in G3_CLIENT_ORIGINS are allowed, only for /api, and never with cookies: the
 * app authenticates with a bearer token, so a listed origin gains nothing a
 * signed-in person does not already have. Unset (the default) means no CORS.
 */
function allowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get('origin');
  if (!origin || !request.nextUrl.pathname.startsWith('/api/')) return null;
  const allowed = (process.env.G3_CLIENT_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function withCors(response: NextResponse, origin: string | null): NextResponse {
  if (!origin) return response;
  response.headers.set('access-control-allow-origin', origin);
  response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.headers.set('access-control-allow-headers', 'authorization,content-type,x-g3-workspace');
  response.headers.set('access-control-max-age', '600');
  response.headers.set('vary', 'origin');
  return response;
}

export async function middleware(request: NextRequest) {
  const origin = allowedOrigin(request);
  if (origin && request.method === 'OPTIONS') return withCors(new NextResponse(null, { status: 204 }), origin);
  return withCors(await refreshSession(request), origin);
}

async function refreshSession(request: NextRequest): Promise<NextResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  // Supabase Auth not configured: nothing to refresh.
  if (!supabaseUrl || !anonKey) return NextResponse.next();

  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;

  if (!refreshToken) return NextResponse.next();
  if (accessToken && !isExpired(accessToken)) return NextResponse.next();

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // The refresh token is spent or revoked. Clear both cookies so the user is
      // asked to sign in again rather than looping on a dead session.
      const cleared = NextResponse.next();
      cleared.cookies.delete(ACCESS_TOKEN_COOKIE);
      cleared.cookies.delete(REFRESH_TOKEN_COOKIE);
      return cleared;
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };

    // Forward the fresh token on THIS request, so the handler downstream does not
    // see the expired one and bounce the user to sign-in.
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${tokens.access_token}`);

    const next = NextResponse.next({ request: { headers } });
    next.cookies.set(ACCESS_TOKEN_COOKIE, tokens.access_token, cookieOptions(tokens.expires_in ?? 3600));
    next.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refresh_token, cookieOptions(60 * 60 * 24 * 30));
    return next;
  } catch {
    // A network failure here must not take the app down; the request proceeds
    // and the handler decides whether the still-valid token is enough.
    return NextResponse.next();
  }
}

export const config = {
  // Everything except static assets. Auth endpoints are included on purpose:
  // signing out needs the current access token to revoke it.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
