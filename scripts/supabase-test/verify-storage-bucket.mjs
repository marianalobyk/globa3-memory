#!/usr/bin/env node
/**
 * The private bucket on the TEST project, checked the way the app uses it.
 *
 *   node scripts/supabase-test/run.mjs node scripts/supabase-test/verify-storage-bucket.mjs
 *
 * Writes ONE throwaway object under a "storage-check/" prefix, proves the rules
 * hold, then deletes it and confirms the bucket is empty again. No workspace
 * file, no capture and no database row is touched.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.SUPABASE_ANON_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'workspace-files';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const server = createClient(url, service, { auth: { persistSession: false } });
const { data: buckets } = await server.storage.listBuckets();
const found = buckets?.find((b) => b.name === bucket);
check('the bucket exists and is private', Boolean(found) && found.public === false);
check('it refuses files larger than the app allows', Number(found?.file_size_limit ?? 0) === Number(process.env.MAX_UPLOAD_BYTES ?? 26_214_400), `limit ${found?.file_size_limit}`);

const key = `storage-check/${randomUUID()}.txt`;
const body = Buffer.from('Throwaway object written by verify-storage-bucket. Safe to delete.');
const { error: upError } = await server.storage.from(bucket).upload(key, body, { contentType: 'text/plain' });
check('the server can store a file', !upError, upError?.message ?? '');

const { data: down, error: downError } = await server.storage.from(bucket).download(key);
check('  and read it back byte for byte', !downError && Buffer.from(await down.arrayBuffer()).equals(body), downError?.message ?? '');

const { data: signed } = await server.storage.from(bucket).createSignedUrl(key, 60);
const signedFetch = signed?.signedUrl ? await fetch(signed.signedUrl).then((r) => r.status) : 0;
check('a signed link works while it is valid', signedFetch === 200, `status ${signedFetch}`);

const publicUrl = `${url}/storage/v1/object/public/${bucket}/${key}`;
const publicStatus = await fetch(publicUrl).then((r) => r.status).catch(() => 0);
check('the same file has no public URL', publicStatus === 400 || publicStatus === 404, `status ${publicStatus}`);

if (anon) {
  const guest = createClient(url, anon, { auth: { persistSession: false } });
  const { data: guestDown, error: guestError } = await guest.storage.from(bucket).download(key);
  check('an anonymous key cannot read it', Boolean(guestError) || !guestDown, guestError?.message ?? 'download succeeded');
  const { error: guestUp } = await guest.storage.from(bucket).upload(`storage-check/${randomUUID()}.txt`, body);
  check('an anonymous key cannot write to it', Boolean(guestUp), guestUp?.message ?? 'upload succeeded');
}

await server.storage.from(bucket).remove([key]);
const { data: left } = await server.storage.from(bucket).list('storage-check');
check('the throwaway object is gone and the bucket is empty', (left?.length ?? 0) === 0, `${left?.length ?? 0} object(s) left`);

console.log(`\n${failures === 0 ? 'All storage checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
