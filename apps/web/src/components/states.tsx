import type { ReactNode } from 'react';
import { AlertTriangle, FlaskConical, Inbox, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The four states every list and detail view needs. Kept in one place so an
 * empty screen always explains what to do next, and an error always says what
 * failed rather than just that something did.
 */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('border-dashed shadow-none', className)}>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon ?? <Inbox className="size-5" />}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  detail,
  onRetry,
  className,
}: {
  title?: string;
  description: string;
  detail?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <Card className={cn('border-destructive/40 bg-destructive/5 shadow-none', className)}>
      <CardContent className="flex flex-col gap-3 px-6 py-8">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{description}</p>
            {detail ? (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-3 font-mono text-xs text-muted-foreground">
                {detail}
              </pre>
            ) : null}
          </div>
        </div>
        {onRetry ? (
          <div>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function LoadingRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border p-4">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function InlineLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Banner shown wherever synthetic output can appear. Mock results must never be
 * mistaken for real research, so this is deliberately hard to miss.
 */
export function MockBanner({
  scope = 'this result',
  className,
}: {
  scope?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm',
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        <span className="font-medium">Mock output.</span> No <code className="font-mono text-xs">OPENAI_API_KEY</code>{' '}
        is configured, so {scope} was produced without any live model call or web search. The content is
        synthetic and must not be used for a decision.
      </p>
    </div>
  );
}
