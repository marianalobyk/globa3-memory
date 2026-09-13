import 'server-only';
import { NextResponse } from 'next/server';
import { errorToPayload, isAppError } from '@g3/core';

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
      const payload = errorToPayload(error);
      const status = isAppError(error) ? error.status : 500;
      if (status >= 500) console.error('[api]', error);
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
    throw Object.assign(new Error('Expected a JSON body'), { status: 400, code: 'bad_request' });
  }
}
