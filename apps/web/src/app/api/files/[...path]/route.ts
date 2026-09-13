import { getStorage, notFound, withUser } from '@g3/core';
import { handler } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

/**
 * Serves a private file.
 *
 * Local storage has no signed URLs, so files stream through here and every
 * request is authenticated and workspace-checked. The path is always prefixed
 * with the active workspace id, so a path from another workspace cannot be
 * requested even if its key were known.
 */
export const GET = handler(
  async (_request: Request, context: { params: Promise<{ path: string[] }> }) => {
    const session = await requireApiSession();
    const workspaceId = activeWorkspaceId(session);
    const { path } = await context.params;
    const relativeKey = path.join('/');

    // The file must belong to a record this user can see, not merely sit at a
    // guessable path.
    const known = await withUser(session.user.id, (db) =>
      db.one<{ source: string }>(
        `select 'upload' as source from public.uploads
           where workspace_id = $1 and storage_path = $2
         union all
         select 'report' from public.daily_reports
           where workspace_id = $1 and storage_path = $2
         limit 1`,
        [workspaceId, `${workspaceId}/${relativeKey}`],
      ),
    );
    if (!known) throw notFound('No stored file matches that path in this workspace');

    const bytes = await getStorage().get(workspaceId, relativeKey);
    const filename = relativeKey.split('/').pop() ?? 'file';
    const contentType = filename.endsWith('.pdf')
      ? 'application/pdf'
      : filename.endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : filename.endsWith('.zip')
          ? 'application/zip'
          : 'application/octet-stream';

    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': contentType,
        'content-disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'private, no-store',
      },
    });
  },
);
