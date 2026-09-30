import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { badRequest, errorToPayload, isAppError } from '@g3/core';

/**
 * Wraps a route handler so domain errors map onto HTTP status codes and nothing
 * leaks a stack trace to the client.
 *
 * Notably: a stale-approval conflict surfaces as 409, which the Review screen
 * turns into "reload and review the current values" rather than a generic error.
 */
export function handler<T extends unknown[]>(
  fn: (...args: T) => Promise<NextResponse | Response>,
): (...args: T) => Promise<NextResponse | Response> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ZodError) {
        // A malformed request is the client's mistake, not a server failure.
        return NextResponse.json(
          {
            error: 'The request was not in the expected shape.',
            code: 'bad_request',
            detail: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        );
      }
      const status = isAppError(error) ? error.status : 500;
      if (status >= 500) console.error('[api]', error);
      // Only deliberate application errors carry their message to the client.
      // Anything unexpected (a database or library error) is logged on the
      // server and answered with a plain sentence: no SQL, function names or
      // stack details reach the browser or the phone.
      const payload = isAppError(error)
        ? errorToPayload(error)
        : { error: 'Something went wrong on the server. Please try again.', code: 'internal' };
      return NextResponse.json(payload, { status });
    }
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest('Expected a JSON body');
  }
}
