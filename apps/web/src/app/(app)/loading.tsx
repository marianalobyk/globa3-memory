import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shown instantly on navigation between sections while the server renders the
 * next screen. With this boundary Next.js prefetches the shared shell of each
 * visible nav link, so a click switches immediately instead of waiting on the
 * page's data. Nothing user-specific is prefetched or cached by it.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
