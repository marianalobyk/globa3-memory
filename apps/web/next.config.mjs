import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// The repository keeps one .env.local at its root; Next.js would otherwise only
// look in apps/web. Loaded here so the dev server, the build and the middleware
// all see the same configuration. Real environment variables still win.
// Skipped under scripts/supabase-test/run.mjs (G3_SKIP_ROOT_ENV=1), whose
// environment must not be topped up from the local development file.
for (const file of process.env.G3_SKIP_ROOT_ENV === '1' ? [] : ['.env.local', '.env']) {
  const path = resolve(process.cwd(), '..', '..', file);
  if (existsSync(path)) loadDotenv({ path, override: false, quiet: true });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A production build can live next to a running `next dev` without either
  // overwriting the other's output: `NEXT_DIST_DIR=.next-prod next build`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // @g3/core and @g3/shared are source-only workspace packages.
  transpilePackages: ['@g3/core', '@g3/shared'],
  // pg, pdf-parse and unzipper must stay external to the server bundle.
  serverExternalPackages: ['pg', 'pdf-parse', 'unzipper'],
  eslint: { ignoreDuringBuilds: true },
  // Briefs, brief formats and brief-based research are no longer part of the
  // product. Their records, migrations and screens are kept, but the screens are
  // not reachable: old links land on Capture instead. Not permanent, so the
  // decision stays reversible without browsers having cached it.
  async redirects() {
    return [
      { source: '/briefs', destination: '/capture', permanent: false },
      { source: '/briefs/:path*', destination: '/capture', permanent: false },
      { source: '/research', destination: '/capture', permanent: false },
      { source: '/research/:path*', destination: '/capture', permanent: false },
    ];
  },
  webpack: (config) => {
    // The workspace packages use NodeNext-style `./module.js` specifiers that
    // resolve to `.ts` sources. Webpack needs to be told about that mapping.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};
export default nextConfig;
