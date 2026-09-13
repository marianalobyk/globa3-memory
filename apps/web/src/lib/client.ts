/** Small fetch helper for client components, with typed errors. */

export interface ApiError {
  error: string;
  code: string;
  detail?: unknown;
}

export class RequestFailed extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(payload.error);
    this.name = 'RequestFailed';
  }

  /** A 409 means the underlying record changed; the UI must reload, not retry. */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (!response.ok) {
    let payload: ApiError = { error: `Request failed (${response.status})`, code: 'unknown' };
    try {
      payload = (await response.json()) as ApiError;
    } catch {
      // keep the default
    }
    throw new RequestFailed(response.status, payload);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
