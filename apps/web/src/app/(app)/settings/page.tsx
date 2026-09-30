import { authMode, devAuthEnabled, hasOpenAi, hasSupabaseStorage } from '@g3/core';
import { redirect } from 'next/navigation';
import { requirePageSession } from '@/lib/session';
import { loadSettingsData } from '@/lib/page-data';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, titleCase } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  // Settings is an administrator's page, not part of the everyday product.
  if (session.activeWorkspace.role !== 'admin') redirect('/');

  const { budgets, members } = await loadSettingsData(session);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Access, AI budget and what is configured in this environment.
        </p>
      </div>

      <Tabs defaultValue="access">
        <TabsList className="flex-wrap">
          <TabsTrigger value="access">Access &amp; budget</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        <TabsContent value="access" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Who can do what</CardTitle>
              <CardDescription>
                Approval is a separate capability from role, so both users can approve records while
                only one administers the workspace.
              </CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Can approve records</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.email}>
                    <TableCell>
                      <p className="text-sm font-medium">{member.display_name ?? member.email}</p>
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={member.role === 'admin' ? 'default' : 'secondary'}>
                        {titleCase(member.role)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={member.can_approve ? 'success' : 'muted'}>
                        {member.can_approve ? 'Yes' : 'No'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Budgets</CardTitle>
              <CardDescription>
                A hard stop refuses to start new runs once exceeded. A warn-only budget surfaces a
                notice but lets work continue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {budgets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No budgets configured.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {budgets.map((budget) => (
                    <li key={budget.period} className="flex items-center gap-2">
                      <Badge variant="outline">{titleCase(budget.period)}</Badge>
                      <span className="tabular-nums">${Number(budget.limit_usd).toFixed(2)}</span>
                      <Badge variant={budget.hard_stop ? 'destructive' : 'secondary'}>
                        {budget.hard_stop ? 'Hard stop' : 'Warn only'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integrations">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Integration status</CardTitle>
              <CardDescription>
                What is actually configured in this environment. Nothing here is inferred.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              {[
                {
                  label: 'OpenAI',
                  on: hasOpenAi(),
                  onText:
                    'Configured. Capture analysis uses live model calls on the captured source only; web search is used only when someone explicitly asks for research.',
                  offText:
                    'No OPENAI_API_KEY. The mock provider runs the full pipeline and every result is labelled synthetic.',
                },
                {
                  label: 'Supabase Auth',
                  on: authMode() === 'supabase',
                  onText:
                    'Configured. Passwords are exchanged with Supabase server-side, tokens are stored in httpOnly cookies, refreshed by middleware, and revoked at Supabase on sign-out.',
                  offText:
                    devAuthEnabled()
                      ? 'Not configured. DEV_AUTH_ENABLED is on, so the local development sign-in is in use and sessions are labelled "Local auth".'
                      : 'Not configured, and the local development sign-in is disabled. Nobody can sign in until SUPABASE_URL and SUPABASE_ANON_KEY are set, or DEV_AUTH_ENABLED=true outside production.',
                },
                {
                  label: 'Supabase Storage',
                  on: hasSupabaseStorage(),
                  onText: 'Configured. Files are stored in a private bucket and served via signed URLs.',
                  offText:
                    'Not configured. Files are stored in a private local directory and streamed through an authenticated route.',
                },
              ].map((integration) => (
                <div key={integration.label} className="flex flex-wrap items-start gap-2 rounded-md border p-3">
                  <Badge variant={integration.on ? 'success' : 'warning'}>
                    {integration.on ? 'Configured' : 'Not configured'}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{integration.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {integration.on ? integration.onText : integration.offText}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
