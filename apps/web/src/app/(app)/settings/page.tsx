import { hasOpenAi, hasSupabaseAuth, hasSupabaseStorage, listFormats, withService, withUser } from '@g3/core';
import type { FormatConfig } from '@g3/shared';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormatSettings } from '@/components/format-settings';
import { formatDateTime, titleCase } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const isAdmin = session.activeWorkspace.role === 'admin';

  const formats = await withService((db) => listFormats(db, workspaceId));

  const { promptVersions, contextItems, budgets, members } = await withUser(
    session.user.id,
    async (db) => ({
      promptVersions: await db.rows<{
        id: string;
        format_id: string;
        version: number;
        checksum: string;
        note: string | null;
        created_at: string;
        is_active: boolean;
      }>(
        `select pv.id, pv.format_id, pv.version, pv.checksum, pv.note, pv.created_at,
                (f.active_prompt_version_id = pv.id) as is_active
           from public.prompt_versions pv
           join public.brief_formats f on f.id = pv.format_id
          where pv.workspace_id = $1
          order by pv.format_id, pv.version desc`,
        [workspaceId],
      ),
      contextItems: await db.rows<{
        id: string;
        kind: string;
        label: string;
        detail: string | null;
        status: string;
        format_key: string | null;
      }>(
        `select c.id, c.kind, c.label, c.detail, c.status, f.key as format_key
           from public.context_items c
           left join public.brief_formats f on f.id = c.format_id
          where c.workspace_id = $1 and c.status = 'active'
          order by c.kind, c.label`,
        [workspaceId],
      ),
      budgets: await db.rows<{ period: string; limit_usd: string; hard_stop: boolean }>(
        `select period, limit_usd, hard_stop from public.budgets where workspace_id = $1`,
        [workspaceId],
      ),
      members: await db.rows<{ email: string; display_name: string | null; role: string; can_approve: boolean }>(
        `select u.email, u.display_name, m.role, m.can_approve
           from public.workspace_members m
           join public.app_users u on u.id = m.user_id
          where m.workspace_id = $1
          order by m.role, u.email`,
        [workspaceId],
      ),
    }),
  );

  const byKind = new Map<string, typeof contextItems>();
  for (const item of contextItems) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Format rules, prompt history, run context, budgets and access.
        </p>
      </div>

      <Tabs defaultValue="formats">
        <TabsList className="flex-wrap">
          <TabsTrigger value="formats">Formats ({formats.length})</TabsTrigger>
          <TabsTrigger value="prompts">Prompt history</TabsTrigger>
          <TabsTrigger value="context">Run context ({contextItems.length})</TabsTrigger>
          <TabsTrigger value="access">Access &amp; budget</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        <TabsContent value="formats" className="space-y-4">
          {formats.map((format) => (
            <FormatSettings
              key={format.id}
              formatId={format.id}
              formatKey={format.key}
              name={format.name}
              productLine={format.product_line}
              defaultModel={format.default_model}
              researchModel={format.research_model}
              config={format.config as FormatConfig}
              canEdit={isAdmin}
            />
          ))}
        </TabsContent>

        <TabsContent value="prompts">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Prompt versions</CardTitle>
              <CardDescription>
                Editing a prompt creates a new version rather than replacing the old one, so every
                brief stays traceable to the exact prompt that produced it.
              </CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Format</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Checksum</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {promptVersions.map((version) => {
                  const format = formats.find((f) => f.id === version.format_id);
                  return (
                    <TableRow key={version.id}>
                      <TableCell className="text-sm">{format?.name ?? version.format_id}</TableCell>
                      <TableCell>
                        <Badge variant={version.is_active ? 'success' : 'outline'}>
                          v{version.version}
                          {version.is_active ? ' · active' : ''}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {version.checksum.slice(0, 12)}
                      </TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {version.note ?? '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(version.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="context">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Run context</CardTitle>
              <CardDescription>
                Priorities, targets, watchlists and open questions are injected into every run from
                here, rather than being left as example values inside the prompt text.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {[...byKind.entries()].map(([kind, items]) => (
                <div key={kind}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {titleCase(kind)}
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {items.map((item) => (
                      <li key={item.id}>
                        <Badge variant="secondary" title={item.detail ?? undefined}>
                          {item.label}
                          {item.format_key ? ` · ${item.format_key}` : ''}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {contextItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No context configured. Runs will inject NONE for every list, which the formats
                  explicitly permit.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

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
                  onText: 'Configured. Live model calls and web search are in use.',
                  offText:
                    'No OPENAI_API_KEY. The mock provider runs the full pipeline and every result is labelled synthetic.',
                },
                {
                  label: 'Supabase Auth',
                  on: hasSupabaseAuth(),
                  onText: 'Configured. Access tokens are verified server-side.',
                  offText:
                    'Not configured. The local development sign-in is in use and sessions are labelled "Local auth".',
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
