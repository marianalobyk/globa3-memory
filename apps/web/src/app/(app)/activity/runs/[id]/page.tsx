import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { RunProgress } from '@/components/run-progress';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const { id } = await params;

  const exists = await withUser(session.user.id, (db) =>
    db.one<{ id: string; kind: string }>(
      `select id, kind from public.runs where workspace_id = $1 and id = $2`,
      [workspaceId, id],
    ),
  );
  if (!exists) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/activity">
          <ArrowLeft />
          Activity
        </Link>
      </Button>
      <RunProgress runId={id} />
    </div>
  );
}
