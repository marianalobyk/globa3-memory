import Link from 'next/link';
import { hasOpenAi } from '@g3/core';
import { getLayoutData } from '@/lib/cached-data';
import { requirePageSession } from '@/lib/session';
import { AppNav } from '@/components/app-nav';
import { WorkspaceBar } from '@/components/workspace-bar';

/**
 * Application shell.
 *
 * The header carries the two facts that change how every screen should be read:
 * which workspace is active, and whether the AI provider is real or mock.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePageSession();

  const { spend, budgets, counts } = await getLayoutData(session);

  return (
    <div className="flex min-h-dvh min-w-0 flex-col">
      <WorkspaceBar
        session={session}
        isMock={!hasOpenAi()}
        spend={spend}
        budgets={budgets}
      />
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <AppNav
          canApprove={session.activeWorkspace.canApprove}
          role={session.activeWorkspace.role}
          counts={counts}
        />
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
      <footer className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Workspace: {session.activeWorkspace.workspaceName}</span>
          <span>Timezone: {session.activeWorkspace.timezone}</span>
          <span>
            Nothing is saved to knowledge without approval.{' '}
            <Link href="/activity" className="underline underline-offset-2">
              Activity
            </Link>{' '}
            records every saved change.
          </span>
        </div>
      </footer>
    </div>
  );
}
