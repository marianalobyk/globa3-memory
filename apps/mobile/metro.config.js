// Metro in the monorepo.
//
// The web app (Next.js) and this app use different React versions: Expo SDK 57
// pins React 19.2.3 to match React Native's renderer. npm hoists the web
// app's React to the repository root, so a package hoisted there (for example
// react-native-web) would otherwise pick up the wrong copy and the bundle would
// contain two Reacts. Every import of react and react-dom is resolved from this
// app's own node_modules instead.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const PINNED = ['react', 'react-dom'];
const appOrigin = path.join(__dirname, 'package.json');
const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pinned = PINNED.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));
  const resolve = upstream ?? context.resolveRequest;
  return pinned
    ? resolve({ ...context, originModulePath: appOrigin }, moduleName, platform)
    : resolve(context, moduleName, platform);
};

// This app talks to the server over HTTP only. It must never bundle the server
// packages, which hold database and model access: fail the build if it tries.
const repoRoot = path.resolve(__dirname, '..', '..');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const serverOnly = ['packages/core', 'apps/web', 'apps/worker'].map(
  (dir) => new RegExp(`^${escape(path.join(repoRoot, dir))}[\\/].*`),
);
const existing = config.resolver.blockList;
config.resolver.blockList = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), ...serverOnly];

module.exports = config;
