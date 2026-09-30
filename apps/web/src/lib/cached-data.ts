import 'server-only';
import { cache } from 'react';
import { loadLayoutData } from './page-data';

/**
 * Per-request memoisation of data read by both the layout and a page.
 *
 * React's cache() lives for a single server render only, so nothing is shared
 * between requests or users. It is keyed by the session object, which
 * getSession() itself caches per request.
 */
export const getLayoutData = cache(loadLayoutData);
