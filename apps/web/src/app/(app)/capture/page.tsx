import Link from 'next/link';
import { ArrowRight, FileText, Inbox, Paperclip, Link2 } from 'lucide-react';
import { getCapture, listCaptures, withService } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CaptureForm } from '@/components/capture-form';
import { formatRelative, truncate } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Capture: one box for anything worth remembering.
 *
 * The primary way into the system: a note after a meeting, a pasted link, or a
 * file. Analysis reads only this source and existing memory; nothing is
 * researched unless a person asks for it afterwards.
 */
export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const { edit } = await searchParams;

  const { editing, captures } = await withService(async (db) => ({
    editing: edit ? await getCapture(db, workspaceId, edit) : null,
    captures: await listCaptures(db, workspaceId, 15),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Capture</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Write what happened, paste a link, or attach a file. It is stored as a source, analysed in the
          background, and comes back as proposed changes for you to approve.
        </p>
      </div>

      {editing ? (
        <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          Editing a capture from {formatRelative(editing.created_at)}. Capturing again replaces it, and its
          earlier proposal is withdrawn.
        </p>
      ) : null}

      <CaptureForm
        autoFocus
        initialText={editing?.body_text ?? ''}
        replacesCaptureId={editing?.id}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recent captures</h2>
        {captures.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
            <Inbox className="size-4" aria-hidden />
            Nothing captured yet. A note of two sentences is enough.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {captures.map((capture) => {
              const href = capture.proposal_id ? `/review/${capture.proposal_id}` : `/capture/${capture.id}`;
              return (
                <li key={capture.id}>
                  <Link
                    href={href}
                    className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm transition-colors hover:bg-accent/40"
                  >
                    <span className="text-muted-foreground">
                      {capture.kind === 'file' ? (
                        <Paperclip className="size-4" aria-hidden />
                      ) : capture.kind === 'url' ? (
                        <Link2 className="size-4" aria-hidden />
                      ) : (
                        <FileText className="size-4" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {truncate(capture.preview ?? capture.filename ?? capture.source_url ?? 'Capture', 90)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatRelative(capture.created_at)}
                        {capture.status === 'failed' && capture.status_detail ? ` · ${capture.status_detail}` : ''}
                      </span>
                    </span>
                    <CaptureStateBadge
                      status={capture.status}
                      awaiting={capture.awaiting}
                      saved={capture.saved}
                    />
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                      {capture.proposal_id ? 'Review' : 'Open'}
                      <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

    </div>
  );
}

function CaptureStateBadge({
  status,
  awaiting,
  saved,
}: {
  status: string;
  awaiting: number;
  saved: number;
}) {
  if (status === 'failed') return <Badge variant="destructive">Analysis stopped</Badge>;
  if (status === 'received' || status === 'analyzing') return <Badge variant="secondary">Analysing</Badge>;
  if (awaiting > 0) return <Badge variant="warning">{awaiting} awaiting review</Badge>;
  if (saved > 0) return <Badge variant="success">{saved} saved</Badge>;
  return <Badge variant="outline">Reviewed</Badge>;
}
