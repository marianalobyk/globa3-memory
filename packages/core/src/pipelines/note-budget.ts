/**
 * How much of a note may become memory, decided by the server.
 *
 * `document-budget.ts` already does this for research documents, for the reason
 * given there: a model asked to read something will happily return every name
 * it contains, and saving all of them turns a decision list into a database
 * import. A long note has exactly the same failure mode -- a page of meeting
 * notes naming a dozen people produces a dozen entity proposals, of which two
 * are the people you actually met.
 *
 * So the same principles are applied here, on the note draft, before anything is
 * proposed:
 *
 *   - keep what the writer was actually in contact with, and what is decision
 *     relevant about them;
 *   - a name that is merely mentioned is context, not a record;
 *   - nothing is deleted: everything trimmed moves to "keep as source only",
 *     with the reason, so the review can say plainly that it stayed in the note.
 *
 * It also turns the draft's gaps into research suggestions, which is the only
 * place a note-shaped capture can offer them. They are suggestions and nothing
 * else: selecting one is a separate, explicit act by the person reviewing, and
 * nothing here starts a search.
 */
import type { CaptureExtraction } from '@g3/shared';

export interface NoteBudget {
  /** People the writer was in contact with. The point of a note. */
  contacts: number;
  facts: number;
  inferences: number;
  recommendations: number;
  actions: number;
  /** Commercial openings. Never more than one unvalidated idea at a time. */
  opportunities: number;
  researchQuestions: number;
}

export const NOTE_BUDGET: NoteBudget = {
  contacts: 6,
  facts: 6,
  inferences: 4,
  recommendations: 3,
  actions: 4,
  opportunities: 1,
  researchQuestions: 2,
};

export interface NoteBudgetResult {
  extraction: CaptureExtraction;
  /** What stayed in the note, with the reason, for the review's third group. */
  sourceOnly: { label: string; why: string }[];
  /** Questions worth researching. Off by default; selecting one is a separate act. */
  researchRecommendations: { subject: string; why: string }[];
  /** One line per trimmed item, for the run log. */
  trimmed: string[];
}

const lower = (s: string) => s.trim().toLowerCase();

/** A short label for a statement, for the "kept in your note" list. */
function shorten(text: string, max = 100): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Trims a note draft to what a person can actually decide on, and moves
 * everything else into "keep as source only".
 *
 * The rules, in order:
 *   1. Keep the people the writer was in contact with, up to the budget.
 *   2. Rank statements by whether they are about one of those people. A fact
 *      about someone you met outranks a fact about a name in passing; within
 *      the same rank, the writer's own order is kept, because people write the
 *      thing that matters first.
 *   3. Keep the soonest follow-ups.
 *   4. Keep at most one commercial opening.
 *   5. Offer the gaps that block useful memory as research suggestions.
 *
 * Names are left alone: see the note in the body.
 */
export function applyNoteBudget(
  extraction: CaptureExtraction,
  budget: NoteBudget = NOTE_BUDGET,
): NoteBudgetResult {
  const trimmed: string[] = [];
  const sourceOnly: { label: string; why: string }[] = [];
  const keepInNote = (label: string, why: string, note: string) => {
    sourceOnly.push({ label, why });
    trimmed.push(note);
  };

  // 1. Contacts.
  const contacts = extraction.contacts.slice(0, budget.contacts);
  for (const dropped of extraction.contacts.slice(budget.contacts)) {
    keepInNote(dropped.name, 'Beyond the people kept above; they stay in your note.', `contact "${dropped.name}"`);
  }
  const contactNames = new Set(contacts.map((c) => lower(c.name)));

  /** Statements about someone the writer met come first, then the writer's order. */
  const byRelevance = <T extends { about: string[] }>(items: T[]): T[] =>
    items
      .map((item, index) => ({ item, index, aboutContact: item.about.some((n) => contactNames.has(lower(n))) }))
      .sort((a, b) => (a.aboutContact === b.aboutContact ? a.index - b.index : a.aboutContact ? -1 : 1))
      .map((entry) => entry.item);

  // 2. Statements.
  const rankedFacts = byRelevance(extraction.facts);
  const facts = rankedFacts.slice(0, budget.facts);
  for (const dropped of rankedFacts.slice(budget.facts)) {
    keepInNote(shorten(dropped.statement), 'Further detail from the same note; it stays in your note.', `fact "${shorten(dropped.statement, 50)}"`);
  }

  const rankedInferences = byRelevance(extraction.inferences);
  const inferences = rankedInferences.slice(0, budget.inferences);
  for (const dropped of rankedInferences.slice(budget.inferences)) {
    keepInNote(shorten(dropped.statement), 'A further reading of the same note; it stays in your note.', `inference "${shorten(dropped.statement, 50)}"`);
  }

  const rankedRecommendations = byRelevance(extraction.recommendations);
  const recommendations = rankedRecommendations.slice(0, budget.recommendations);
  for (const dropped of rankedRecommendations.slice(budget.recommendations)) {
    keepInNote(shorten(dropped.statement), 'A further suggestion from the same note; it stays in your note.', `recommendation "${shorten(dropped.statement, 50)}"`);
  }

  // 3. Follow-ups: the soonest first, undated last, then the writer's order.
  const rankedActions = [...extraction.actions]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = a.item.due_on ?? '9999-12-31';
      const right = b.item.due_on ?? '9999-12-31';
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((entry) => entry.item);
  const actions = rankedActions.slice(0, budget.actions);
  for (const dropped of rankedActions.slice(budget.actions)) {
    keepInNote(dropped.title, 'Beyond the follow-ups kept above; it stays in your note.', `action "${dropped.title}"`);
  }

  // 4. Commercial openings.
  const opportunities = extraction.opportunities.slice(0, budget.opportunities);
  for (const dropped of extraction.opportunities.slice(budget.opportunities)) {
    keepInNote(dropped.title, 'An opening the note raises; only one unvalidated idea is offered at a time.', `opportunity "${dropped.title}"`);
  }

  // Names are deliberately NOT trimmed.
  //
  // A mention is not a record: the resolve and contextualize stages decide
  // separately which names become entities, and a name that is only mentioned
  // already stays context (verify:capture §12, "a place is not an event").
  // Trimming the list therefore removes no proposed record -- it only destroys
  // the context the interaction summary reads from ("You met Lena at Cannes
  // today") and the place, event and organisation clues the research preflight
  // offers. An earlier version of this file cut them and broke exactly that.

  // 6. Gaps -> research suggestions. A gap only earns one when the note says why
  // it matters; a question with no stated stake is not worth a search.
  const researchRecommendations = extraction.gaps
    .filter((gap) => gap.question.trim().length > 0 && gap.why_it_matters.trim().length > 0)
    .slice(0, budget.researchQuestions)
    .map((gap) => ({ subject: gap.question.trim(), why: gap.why_it_matters.trim() }));
  for (const dropped of extraction.gaps.slice(researchRecommendations.length)) {
    trimmed.push(`research question "${shorten(dropped.question, 50)}"`);
  }

  return {
    extraction: { ...extraction, contacts, facts, inferences, recommendations, actions, opportunities },
    sourceOnly,
    researchRecommendations,
    trimmed,
  };
}
