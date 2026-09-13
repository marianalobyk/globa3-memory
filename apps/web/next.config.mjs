/** @type {import('next').NextConfig} */
const nextConfig = {
  // @g3/core and @g3/shared are source-only workspace packages.
  transpilePackages: ['@g3/core', '@g3/shared'],
  // pg, pdf-parse and unzipper must stay external to the server bundle.
  serverExternalPackages: ['pg', 'pdf-parse', 'unzipper'],
  eslint: { ignoreDuringBuilds: true },
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
