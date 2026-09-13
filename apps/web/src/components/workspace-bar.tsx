'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FlaskConical, LogOut, Wallet } from 'lucide-react';
import type { CostSummary, Session } from '@g3/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/client';
import { formatCost } from '@/lib/utils';

interface BudgetState {
  period: string;
  limitUsd: number;
  spentUsd: number;
  hardStop: boolean;
  exceeded: boolean;
  spendIsEstimate: boolean;
}

export function WorkspaceBar({
  session,
  isMock,
  spend,
  budgets,
}: {
  session: Session;
  isMock: boolean;
  spend: CostSummary & { periodDays: number };
  budgets: BudgetState[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const switchWorkspace = async (workspaceId: string) => {
    setBusy(true);
    try {
      await api('/api/workspace', { method: 'POST', json: { workspaceId } });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  };

  const monthBudget = budgets.find((b) => b.period === 'month');

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5 sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">Globa 3 Intelligence</span>
        {session.workspaces.length > 1 ? (
          <Select
            value={session.activeWorkspace.workspaceId}
            onValueChange={switchWorkspace}
            disabled={busy}
          >
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {session.workspaces.map((w) => (
                <SelectItem key={w.workspaceId} value={w.workspaceId}>
                  {w.workspaceName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="secondary">{session.activeWorkspace.workspaceName}</Badge>
        )}
      </div>

      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {isMock ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning">
                <FlaskConical />
                Mock AI
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              No OPENAI_API_KEY is configured. Generated content is synthetic and labelled; no live
              search or model integration is in use.
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={monthBudget?.exceeded ? 'destructive' : 'outline'}>
              <Wallet />
              {formatCost(spend.totalUsd, spend.hasEstimates)} / {spend.periodDays}d
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {spend.hasEstimates
              ? 'Some figures are estimates: either the provider did not report token counts, or no price is configured for the model.'
              : 'Actual reported spend.'}
            {monthBudget
              ? ` Monthly budget: ${formatCost(monthBudget.spentUsd, monthBudget.spendIsEstimate)} of $${monthBudget.limitUsd.toFixed(2)}${monthBudget.hardStop ? ' (hard stop)' : ' (warn only)'}.`
              : ' No budget configured.'}
          </TooltipContent>
        </Tooltip>

        {session.isDevAuth ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline">Local auth</Badge>
            </TooltipTrigger>
            <TooltipContent>
              This session was issued by the local development auth provider, not Supabase Auth.
            </TooltipContent>
          </Tooltip>
        ) : null}

        <span className="hidden text-xs text-muted-foreground sm:inline">{session.user.email}</span>
        <Button variant="ghost" size="icon" onClick={signOut} title="Sign out">
          <LogOut />
          <span className="sr-only">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
