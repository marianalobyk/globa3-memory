/**
 * The app's only connection to Globa 3: authenticated HTTP calls to the server.
 *
 * The app holds no Supabase key, no database URL and no model key. It holds the
 * signed-in person's own session token (in the iOS Keychain, see session.ts),
 * sends it as a bearer header, and the server verifies it on every request and
 * applies the same workspace rules, approval checks and audit trail as the web
 * app. Business rules -- what a change is called, which group it belongs to,
 * whether a name matched memory -- arrive already decided in the responses.
 */
import { Platform } from 'react-native';
import { loadTokens, saveTokens, clearTokens, type StoredTokens } from './session';
import type {
  AskAnswer,
  CaptureView,
  ProposalView,
  ResearchPreflight,
  ReviewList,
  SessionInfo,
  TodayView,
} from './types';

const configured = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');

export const API_URL = configured && configured.length > 0 ? configured : 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

let refreshing: Promise<StoredTokens | null> | null = null;
let onSignedOut: (() => void) | null = null;

/** Called by the session provider so a dead session sends the person to sign-in. */
export function setSignedOutHandler(handler: (() => void) | null) {
  onSignedOut = handler;
}

async function refreshTokens(tokens: StoredTokens): Promise<StoredTokens | null> {
  if (!tokens.refreshToken) return null;
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/api/mobile/session/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { accessToken: string; refreshToken: string; expiresAt: number };
      const next = { ...tokens, ...body };
      await saveTokens(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function request<T>(
  path: string,
  init: { method?: string; json?: unknown; form?: FormData; auth?: boolean } = {},
): Promise<T> {
  let tokens = init.auth === false ? null : await loadTokens();
  if (tokens?.refreshToken && tokens.expiresAt * 1000 - 60_000 < Date.now()) {
    tokens = (await refreshTokens(tokens)) ?? tokens;
  }

  const send = (current: StoredTokens | null) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    if (current) {
      headers.authorization = `Bearer ${current.accessToken}`;
      if (current.workspaceId) headers['x-g3-workspace'] = current.workspaceId;
    }
    return fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    });
  };

  let response: Response;
  try {
    response = await send(tokens);
  } catch {
    throw new ApiError('Cannot reach Globa 3. Check your connection and try again.', 0, 'network');
  }

  if (response.status === 401 && tokens) {
    const renewed = await refreshTokens(tokens);
    if (renewed) response = await send(renewed);
    if (response.status === 401) {
      await clearTokens();
      onSignedOut?.();
    }
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const payload = (body ?? {}) as { error?: string; code?: string };
    throw new ApiError(payload.error ?? 'Something went wrong.', response.status, payload.code ?? null);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function signIn(email: string, password: string): Promise<void> {
  const result = await request<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
    workspaceId: string;
  }>('/api/mobile/session', { method: 'POST', json: { email, password }, auth: false });
  await saveTokens({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    workspaceId: result.workspaceId,
  });
}

export async function signOut(): Promise<void> {
  try {
    await request('/api/mobile/session', { method: 'DELETE' });
  } catch {
    // Signing out locally must work offline too.
  }
  await clearTokens();
}

export const getSession = () => request<SessionInfo>('/api/mobile/session');

// ---------------------------------------------------------------------------
// Today, capture, review, knowledge
// ---------------------------------------------------------------------------

export const getToday = () => request<TodayView>('/api/mobile/today');

export interface Attachment {
  name: string;
  mimeType: string | null;
  uri: string;
  /** Present on web, where the picker returns a real File. */
  file?: File | null;
}

export async function submitCapture(input: {
  text: string;
  attachment?: Attachment | null;
  replacesCaptureId?: string | null;
}): Promise<{ captureId: string; created: boolean }> {
  const form = new FormData();
  form.append('text', input.text);
  if (input.replacesCaptureId) form.append('replacesCaptureId', input.replacesCaptureId);
  if (input.attachment) {
    if (Platform.OS === 'web' && input.attachment.file) {
      form.append('file', input.attachment.file, input.attachment.name);
    } else {
      // React Native's FormData streams the file from its local URI.
      form.append('file', {
        uri: input.attachment.uri,
        name: input.attachment.name,
        type: input.attachment.mimeType ?? 'application/octet-stream',
      } as unknown as Blob);
    }
  }
  return request('/api/captures', { method: 'POST', form });
}

export const getCapture = (id: string) => request<CaptureView>(`/api/captures/${id}`);

export const retryCapture = (id: string) => request(`/api/captures/${id}/retry`, { method: 'POST' });

export const getReviewList = () => request<ReviewList>('/api/mobile/review');

export const getProposal = (id: string) => request<ProposalView>(`/api/mobile/proposals/${id}`);

export const approveChanges = (id: string, expectedVersion: number, itemIds: string[], options: { closeRest?: boolean } = {}) =>
  request<{ written: number; alreadySaved: number; proposal: ProposalView }>(`/api/mobile/proposals/${id}`, {
    method: 'POST',
    json: { action: 'approve', expectedVersion, itemIds, closeRest: options.closeRest ?? false },
  });

export const rejectProposal = (id: string) =>
  request<{ proposal: ProposalView }>(`/api/mobile/proposals/${id}`, {
    method: 'POST',
    json: { action: 'reject' },
  });

const proposalAction = (id: string, json: Record<string, unknown>) =>
  request<{ written: number; alreadySaved: number; proposal: ProposalView }>(`/api/mobile/proposals/${id}`, {
    method: 'POST',
    json,
  });

/** What research would use and what stays private. Starts nothing. */
export const researchPreflight = (proposalId: string, contactKey: string) =>
  request<{ preflight: ResearchPreflight }>(`/api/mobile/proposals/${proposalId}`, {
    method: 'POST',
    json: { action: 'research_preflight', contactKey },
  }).then((r) => r.preflight);

/**
 * Starts identity research for one contact -- only after the person confirmed
 * both cost and disclosure in the preflight, with the clues they kept.
 */
export const researchContact = (proposalId: string, contactKey: string, clueIds: string[]) =>
  proposalAction(proposalId, { action: 'research', contactKey, acknowledgeCost: true, acknowledgeDisclosure: true, clueIds });

/** "This is the person" (a candidate index), "None of these", or "I need to add more context". */
export const confirmIdentity = (proposalId: string, contactKey: string, choice: number | 'none' | 'needs_context') =>
  proposalAction(proposalId, { action: 'confirm_identity', contactKey, choice });

export const markImportant = (proposalId: string, contactKey: string, important: boolean) =>
  proposalAction(proposalId, { action: 'mark_important', contactKey, important });

/** Reads the same stored source again and replaces this proposal with the new reading. */
export const reanalyseProposal = (proposalId: string) =>
  request<{ reanalysing: boolean; captureId: string }>(`/api/mobile/proposals/${proposalId}`, {
    method: 'POST',
    json: { action: 'reanalyse' },
  });

/** Discards the whole capture proposal: nothing from it is saved. */
export const discardProposal = (proposalId: string) => proposalAction(proposalId, { action: 'discard' });

export const askKnowledge = (question: string) =>
  request<AskAnswer>('/api/ask', { method: 'POST', json: { question } });
