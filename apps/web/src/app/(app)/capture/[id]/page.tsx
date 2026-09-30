import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Paperclip } from 'lucide-react';
import { requirePageSession } from '@/lib/session';
import { loadCaptureView } from '@/lib/capture-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CaptureStatus } from '@/components/capture-status';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** One capture: the stored source, and how far its analysis has got. */
export default async function CaptureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePageSession();
  const view = await loadCaptureView(session, id);
  if (!view) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/capture">
          <ArrowLeft />
          Capture
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Captured {formatDateTime(view.capturedAt)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Stored privately in this workspace as an untrusted source.
          </p>
        </div>
        <Badge variant="outline">{view.kind === 'file' ? 'File' : view.kind === 'url' ? 'Link' : 'Note'}</Badge>
      </div>

      <CaptureStatus captureId={view.id} initial={view} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">The source</h2>
        {view.source.text ? (
          <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{view.source.text}</p>
        ) : null}
        {view.source.filename ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Paperclip className="size-4" aria-hidden />
            {view.source.filename} — kept in private storage, not shared.
          </p>
        ) : null}
        {view.source.url ? (
          <p className="text-sm text-muted-foreground">
            Link in the note: <span className="break-all">{view.source.url}</span> — kept as a reference. Pages are
            not opened or searched automatically.
          </p>
        ) : null}
      </section>
    </div>
  );
}
