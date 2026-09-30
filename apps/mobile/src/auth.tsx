/**
 * Who is signed in, for the whole app.
 *
 * On launch the stored token is checked against the server (GET session). If it
 * is missing or refused, the app shows sign-in; nothing else renders without a
 * verified session.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from './api';
import { loadTokens } from './session';
import type { SessionInfo } from './types';

interface AuthState {
  status: 'loading' | 'signed-out' | 'signed-in';
  session: SessionInfo | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);

  const reload = useCallback(async () => {
    if (!(await loadTokens())) {
      setSession(null);
      setStatus('signed-out');
      return;
    }
    try {
      setSession(await api.getSession());
      setStatus('signed-in');
    } catch (error) {
      if (error instanceof api.ApiError && error.status === 0) {
        // Offline with a stored session: stay signed in; screens show the error.
        setStatus('signed-in');
        return;
      }
      setSession(null);
      setStatus('signed-out');
    }
  }, []);

  useEffect(() => {
    api.setSignedOutHandler(() => {
      setSession(null);
      setStatus('signed-out');
    });
    void reload();
    return () => api.setSignedOutHandler(null);
  }, [reload]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      reload,
      signIn: async (email, password) => {
        await api.signIn(email, password);
        await reload();
      },
      signOut: async () => {
        await api.signOut();
        setSession(null);
        setStatus('signed-out');
      },
    }),
    [status, session, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
