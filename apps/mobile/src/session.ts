/**
 * Where the signed-in person's session token lives.
 *
 * On iOS: the Keychain, via expo-secure-store, readable only by this app and
 * only after the device is first unlocked. The token is the person's own
 * session, not a service credential.
 *
 * On web (used only to preview the app during development) there is no
 * Keychain, so the token is kept in memory for the life of the tab and never
 * written to browser storage.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds since the epoch. */
  expiresAt: number;
  workspaceId: string | null;
}

const KEY = 'g3.session';
let memory: StoredTokens | null = null;

/**
 * Local design previews only: a web development build may start signed in with
 * a short-lived LOCAL dev session minted by scripts (never typed into the form).
 * Compiled out of native and production builds by the __DEV__ / web checks.
 */
const previewToken =
  Platform.OS === 'web' && __DEV__ ? process.env.EXPO_PUBLIC_DEV_PREVIEW_TOKEN || null : null;

export async function loadTokens(): Promise<StoredTokens | null> {
  if (Platform.OS === 'web') {
    return memory ?? (previewToken ? { accessToken: previewToken, refreshToken: null, expiresAt: Date.now() / 1000 + 3600, workspaceId: null } : null);
  }
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  if (Platform.OS === 'web') {
    memory = tokens;
    return;
  }
  await SecureStore.setItemAsync(KEY, JSON.stringify(tokens), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export async function clearTokens(): Promise<void> {
  memory = null;
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(KEY);
}
