/**
 * The Next.js CLI of the web app, wherever npm installed it.
 *
 * npm may hoist `next` to the repository root or keep it under apps/web (it does
 * the latter when the mobile app's tooling has hoisted different versions of
 * next's own dependencies, such as sharp). Resolve it from the web app, as
 * Node's module resolution would, instead of assuming a location.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireFromWeb = createRequire(join(root, 'apps/web/package.json'));

export const nextBin = join(dirname(requireFromWeb.resolve('next/package.json')), 'dist', 'bin', 'next');
