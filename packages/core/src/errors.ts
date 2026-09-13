/** Errors that map onto HTTP status codes at the route boundary. */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (m = 'Not signed in') => new AppError(m, 401, 'unauthorized');
export const forbidden = (m = 'Not permitted') => new AppError(m, 403, 'forbidden');
export const notFound = (m = 'Not found') => new AppError(m, 404, 'not_found');
export const badRequest = (m: string, detail?: unknown) => new AppError(m, 400, 'bad_request', detail);
/** Used when an approval no longer matches the current proposal version. */
export const conflict = (m: string, detail?: unknown) => new AppError(m, 409, 'conflict', detail);
export const tooLarge = (m: string) => new AppError(m, 413, 'payload_too_large');
export const budgetExceeded = (m: string, detail?: unknown) =>
  new AppError(m, 402, 'budget_exceeded', detail);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorToPayload(e: unknown): { error: string; code: string; detail?: unknown } {
  if (isAppError(e)) return { error: e.message, code: e.code, detail: e.detail };
  return { error: e instanceof Error ? e.message : 'Unexpected error', code: 'internal' };
}
