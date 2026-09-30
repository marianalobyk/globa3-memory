#!/usr/bin/env node
/**
 * Creates the private file bucket on the TEST project, once.
 *
 *   node scripts/supabase-test/run.mjs node scripts/supabase-test/create-storage-bucket.mjs
 *
 * The bucket is PRIVATE: no public URL, no anonymous read. The server reaches it
 * with the service-role key and hands out short-lived signed URLs (storage.ts).
 * Idempotent: an existing bucket is left exactly as it is. Nothing else in the
 * project is touched, and no file is uploaded here.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'workspace-files';
const limit = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
if (!url || !key) {
  console.error('This target has no Supabase storage configured.');
  process.exit(2);
}

const client = createClient(url, key, { auth: { persistSession: false } });
const { data: buckets, error: listError } = await client.storage.listBuckets();
if (listError) {
  console.error('Could not list buckets:', listError.message);
  process.exit(1);
}
const existing = buckets.find((b) => b.name === bucket);
if (existing) {
  console.log(`Bucket "${bucket}" already exists (public: ${existing.public}). Nothing changed.`);
  process.exit(existing.public ? 1 : 0);
}

const { error } = await client.storage.createBucket(bucket, {
  public: false,
  fileSizeLimit: limit,
  // What capture accepts today: Markdown, plain text and PDF. The phone's picker
  // sometimes sends a generic type, so that is allowed too.
  allowedMimeTypes: ['text/markdown', 'text/plain', 'application/pdf', 'application/octet-stream'],
});
if (error) {
  console.error('Could not create the bucket:', error.message);
  process.exit(1);
}
const { data: after } = await client.storage.listBuckets();
const made = after?.find((b) => b.name === bucket);
console.log(`Created "${bucket}": private=${made ? !made.public : 'unknown'}, size limit ${Math.round(limit / 1_048_576)} MB.`);
