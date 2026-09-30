import { z } from 'zod';
import { askKnowledge, subjectBriefing, withService, withUserRead } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { recordKind } from '@/lib/labels';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.object({ question: z.string().min(3).max(2000), threadId: z.string().uuid().optional() });

/**
 * Ask Knowledge: answers from saved records only, with citations.
 *
 * Runs inline rather than as a background job: retrieval is a SQL query and the
 * answer is one model call, so there is nothing to keep alive across a restart.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const body = Body.parse(await readJson(request));

  const answer = await askKnowledge(workspaceId, body.question, { userId: session.user.id });

  // When the question is about one stored person, lead with a briefing built
  // from their saved records, in the order a person reads: who they are, what
  // happened, what is known, what is not, what to do next. Read under the
  // asker's own access rules; never invented, never from the model.
  // The subject of the question, as the person wrote it: "Why does Rumesh
  // Tharanga matter to AMV?" is about Rumesh Tharanga.
  const subject =
    body.question
      .replace(/^(?:what|who|why)\b[^?]*?\b(?:about|does|do|is|are|makes?)\s+/i, '')
      .replace(/\s+(?:matter|matters|mattered)\b.*$/i, '')
      .replace(/[?.]+$/, '')
      .trim() || body.question;
  const briefing = await withUserRead(session.user.id, (db) =>
    subjectBriefing(db, workspaceId, subject, { timeZone: session.activeWorkspace.timezone || 'UTC' }),
  ).catch(() => null);

  // Persist the exchange so Knowledge keeps a history. Written by the server
  // role, scoped to the session's verified workspace and user: client roles hold
  // no write privilege (migration 0018). A thread id from the body is only
  // reused when it belongs to this workspace.
  const threadId = await withService(async (db) => {
    const thread = body.threadId
      ? await db.one<{ id: string }>(
          `select id from public.ask_threads where workspace_id = $1 and id = $2`,
          [workspaceId, body.threadId],
        )
      : null;
    const id =
      thread?.id ??
      (
        await db.oneOrFail<{ id: string }>(
          `insert into public.ask_threads (workspace_id, title, created_by) values ($1,$2,$3) returning id`,
          [workspaceId, body.question.slice(0, 120), session.user.id],
        )
      ).id;

    await db.query(
      `insert into public.ask_messages (workspace_id, thread_id, role, content, created_by)
       values ($1,$2,'user',$3,$4)`,
      [workspaceId, id, body.question, session.user.id],
    );
    await db.query(
      `insert into public.ask_messages
         (workspace_id, thread_id, role, content, citations, is_mock, cost_usd, created_by)
       values ($1,$2,'assistant',$3,$4::jsonb,$5,$6,$7)`,
      [
        workspaceId,
        id,
        answer.answerMd,
        JSON.stringify(answer.citations),
        answer.isMock,
        answer.costUsd,
        session.user.id,
      ],
    );
    return id;
  });

  // Each supporting record also says what it is (a person, a finding, a source),
  // so a client never has to show a storage name.
  return ok({
    ...answer,
    briefing,
    citations: answer.citations.map((c) => ({ ...c, kind: recordKind(c.table_name) })),
    threadId,
  });
});
