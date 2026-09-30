import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ApiError } from './api';

/**
 * Loads a screen's data, reloads when the screen comes back into view, and
 * optionally polls while `pollWhile` says the data is still changing.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  options: { pollWhile?: (data: T) => boolean; intervalMs?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    try {
      const next = await loadRef.current();
      setData(next);
      setError(null);
      return next;
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not load this screen.');
      return null;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void run();
    }, [run]),
  );

  const polling = data !== null && options.pollWhile ? options.pollWhile(data) : false;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void run(), options.intervalMs ?? 1500);
    return () => clearInterval(timer);
  }, [polling, run, options.intervalMs]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await run();
    setRefreshing(false);
  }, [run]);

  return { data, setData, error, refreshing, refresh, reload: run };
}
