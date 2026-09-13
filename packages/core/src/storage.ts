/**
 * Private file storage.
 *
 * Supabase mode uses a private bucket through the service-role client, and hands
 * out short-lived signed URLs only. Local mode writes to a directory outside the
 * web root, served through an authenticated route.
 *
 * Every key is prefixed with the workspace id, so file isolation follows the
 * same boundary as row isolation and a path cannot be built that crosses it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, hasSupabaseStorage } from './env.js';
import { AppError, badRequest, notFound } from './errors.js';

export interface StoredObject {
  key: string;
  byteSize: number;
  checksum: string;
  contentType: string;
}

export interface Storage {
  readonly kind: 'supabase' | 'local';
  put(workspaceId: string, relativeKey: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(workspaceId: string, relativeKey: string): Promise<Buffer>;
  remove(workspaceId: string, relativeKey: string): Promise<void>;
  /** A time-limited URL, or null when the file must be streamed through the app. */
  signedUrl(workspaceId: string, relativeKey: string, expiresInSeconds?: number): Promise<string | null>;
}

/** Rejects traversal, absolute paths and anything that could escape the prefix. */
function safeKey(workspaceId: string, relativeKey: string): string {
  const cleaned = relativeKey.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.length === 0) throw badRequest('Empty storage key');
  if (cleaned.includes('..')) throw badRequest('Storage key may not traverse directories');
  if (cleaned.includes('\0')) throw badRequest('Invalid storage key');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw badRequest('Invalid workspace id for storage key');
  return `${workspaceId}/${cleaned}`;
}

function checksumOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

class SupabaseStorageAdapter implements Storage {
  readonly kind = 'supabase' as const;
  private client: SupabaseClient;
  private bucket: string;

  constructor() {
    const e = env();
    this.client = createClient(e.SUPABASE_URL as string, e.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false },
    });
    this.bucket = e.SUPABASE_STORAGE_BUCKET;
  }

  async put(workspaceId: string, relativeKey: string, body: Buffer, contentType: string) {
    const key = safeKey(workspaceId, relativeKey);
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(key, body, { contentType, upsert: true });
    if (error) throw new AppError(`Storage upload failed: ${error.message}`, 502, 'storage_error');
    return { key, byteSize: body.byteLength, checksum: checksumOf(body), contentType };
  }

  async get(workspaceId: string, relativeKey: string) {
    const key = safeKey(workspaceId, relativeKey);
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) throw notFound(`Stored file not found: ${relativeKey}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async remove(workspaceId: string, relativeKey: string) {
    const key = safeKey(workspaceId, relativeKey);
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) throw new AppError(`Storage delete failed: ${error.message}`, 502, 'storage_error');
  }

  async signedUrl(workspaceId: string, relativeKey: string, expiresInSeconds = 300) {
    const key = safeKey(workspaceId, relativeKey);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, expiresInSeconds);
    if (error || !data) throw new AppError(`Could not sign URL: ${error?.message}`, 502, 'storage_error');
    return data.signedUrl;
  }
}

class LocalStorageAdapter implements Storage {
  readonly kind = 'local' as const;
  private root: string;

  constructor() {
    this.root = resolve(process.cwd(), env().LOCAL_STORAGE_DIR);
  }

  private pathFor(workspaceId: string, relativeKey: string): string {
    const key = safeKey(workspaceId, relativeKey);
    const full = resolve(this.root, key);
    // Second line of defence: the resolved path must stay inside the root.
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw badRequest('Storage key escapes the storage root');
    }
    return full;
  }

  async put(workspaceId: string, relativeKey: string, body: Buffer, contentType: string) {
    const full = this.pathFor(workspaceId, relativeKey);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    return {
      key: safeKey(workspaceId, relativeKey),
      byteSize: body.byteLength,
      checksum: checksumOf(body),
      contentType,
    };
  }

  async get(workspaceId: string, relativeKey: string) {
    // Resolve the path OUTSIDE the try: a rejected key is a bad request, and
    // collapsing it into "not found" would hide the reason it was refused.
    const full = this.pathFor(workspaceId, relativeKey);
    try {
      return await readFile(full);
    } catch {
      throw notFound(`Stored file not found: ${relativeKey}`);
    }
  }

  async remove(workspaceId: string, relativeKey: string) {
    await unlink(this.pathFor(workspaceId, relativeKey)).catch(() => {});
  }

  /** Local files are streamed through an authenticated route, never linked directly. */
  async signedUrl(): Promise<string | null> {
    return null;
  }
}

let storage: Storage | null = null;

export function getStorage(): Storage {
  if (!storage) storage = hasSupabaseStorage() ? new SupabaseStorageAdapter() : new LocalStorageAdapter();
  return storage;
}

/** Deterministic key for an uploaded file. */
export function uploadKey(uploadId: string, filename: string): string {
  const safeName = filename.replace(/[^\w.\-]+/g, '_').slice(-120);
  return join('uploads', uploadId, safeName).replace(/\\/g, '/');
}

export function reportKey(reportDate: string): string {
  return `reports/daily-report-${reportDate}.md`;
}

export function briefKey(runDate: string, filename: string): string {
  return `briefs/${runDate}/${filename}`;
}
