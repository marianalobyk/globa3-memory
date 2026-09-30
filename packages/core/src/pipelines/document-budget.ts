/**
 * How much of a document may become memory, decided by the server.
 *
 * A model asked to read a radar will happily return every actor it names: the
 * publisher, the imprint, the audio platform, the agency, the governing body.
 * Saving all of them turns a decision list into a database import -- the first
 * live run produced 40 items for a brief whose actual decisions number about
 * nineteen.
 *
 * So the draft is trimmed here, deterministically, after extraction and before
 * anything is proposed. Nothing is deleted: everything trimmed moves into
 * `source_only`, with the reason, so the review can say plainly that it stayed
 * in the document. The model is never trusted to keep itself small.
 */
import type { DocumentExtraction } from '@g3/shared';

export interface DocumentBudget {
  signals: number;
  watchItems: number;
  /** Decision-relevant people, companies, projects and institutions that become records. */
  coreSubjects: number;
  gaps: number;
  risks: number;
  /** Ideas the document did not confirm. Never saved by default. */
  hypotheses: number;
  researchRecommendations: number;
}

export const DOCUMENT_BUDGET: DocumentBudget = {
  signals: 4,
  watchItems: 4,
  // This is only a guard against a malformed extraction. It must leave room
  // for every genuinely record-worthy person, organisation and project across
  // the four signals a person is being asked to review.
  coreSubjects: 20,
  gaps: 2,
  risks: 1,
  hypotheses: 1,
  researchRecommendations: 2,
};

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Highest priority first, then the document's own order.
 *
 * Confidence deliberately does not rank: how sure the document is about an item
 * says nothing about how much it matters. A radar already leads with what its
 * author thinks is most important, so equal priorities keep that order.
 */
function byImportance<T extends { priority?: string }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const priority = (PRIORITY_RANK[a.item.priority ?? 'medium'] ?? 1) - (PRIORITY_RANK[b.item.priority ?? 'medium'] ?? 1);
      return priority !== 0 ? priority : a.index - b.index;
    })
    .map((entry) => entry.item);
}

export interface BudgetResult {
  extraction: DocumentExtraction;
  /** One line per trimmed item, for the run log. */
  trimmed: string[];
}

/**
 * Trims a document draft to what a person can actually decide on, and moves
 * everything else into "keep as source only".
 *
 * The rules, in order:
 *   1. Keep the most important signals, up to the budget.
 *   2. A record is created only for decision-relevant subjects of a kept
 *      signal (role "subject"). Incidental publishers, imprints, platforms,
 *      agencies, governing bodies and other contextual actors stay in the
 *      document.
 *   3. Keep the earliest watch dates, up to the budget.
 *   4. Keep the most severe unknowns: risks before gaps, each within its budget.
 *   5. Keep at most one hypothesis, and only about a subject that survived.
 *   6. Keep the research suggestions for surviving subjects, up to the budget.
 */
export function applyDocumentBudget(
  extraction: DocumentExtraction,
  budget: DocumentBudget = DOCUMENT_BUDGET,
): BudgetResult {
  const trimmed: string[] = [];
  const sourceOnly = [...extraction.source_only];
  const keepInDocument = (label: string, why: string, note: string) => {
    sourceOnly.push({ label, why });
    trimmed.push(note);
  };

  // 1. Signals.
  const rankedSignals = byImportance(extraction.signals);
  const signals = rankedSignals.slice(0, budget.signals);
  for (const dropped of rankedSignals.slice(budget.signals)) {
    keepInDocument(dropped.title, 'Lower priority than the signals kept above; it stays in your document.', `signal "${dropped.title}"`);
  }

  // 2. Decision-relevant subjects, only up to the safety ceiling. Give every
  // kept signal a representative first: otherwise an early funding slate can
  // spend the whole allowance and hide the person or project in a later signal.
  // A generic "other" has no useful canonical record type, so it stays as
  // source context instead of becoming a catch-all memory record.
  const core = new Map<string, string>();
  const subjectCandidates = new Map<string, { name: string; kind: string; firstSeen: number }>();
  let firstSeen = 0;
  for (const signal of signals) {
    for (const subject of signal.subjects) {
      if (subject.role !== 'subject' || subject.kind === 'other') continue;
      const key = subject.name.toLowerCase();
      if (!subjectCandidates.has(key)) {
        subjectCandidates.set(key, { name: subject.name, kind: subject.kind, firstSeen: firstSeen++ });
      }
    }
  }
  const keepSubject = (name: string) => {
    if (core.size >= budget.coreSubjects) return;
    core.set(name.toLowerCase(), name);
  };

  for (const signal of signals) {
    const recordSubjects = signal.subjects.filter((subject) => subject.role === 'subject' && subject.kind !== 'other');
    const representative = recordSubjects[0];
    if (representative) keepSubject(representative.name);
  }
  const remaining = [...subjectCandidates.values()].sort((left, right) => left.firstSeen - right.firstSeen);
  for (const subject of remaining) {
    if (!core.has(subject.name.toLowerCase())) keepSubject(subject.name);
  }

  const deferredSubjects = new Map<string, string>();
  const contextual = new Map<string, string>();
  for (const signal of signals) {
    for (const subject of signal.subjects) {
      if (core.has(subject.name.toLowerCase())) continue;
      if (subject.role === 'subject') deferredSubjects.set(subject.name.toLowerCase(), subject.name);
      else contextual.set(subject.name.toLowerCase(), subject.name);
    }
  }
  const trimmedSignals = signals.map((signal) => ({
    ...signal,
    subjects: signal.subjects.filter((s) => core.has(s.name.toLowerCase())),
  }));
  for (const name of contextual.values()) {
    keepInDocument(
      name,
      'Named in the document as context, not as what a signal is about. No record is created.',
      `contextual actor "${name}"`,
    );
  }
  for (const name of deferredSubjects.values()) {
    keepInDocument(
      name,
      'A named subject that does not have a clear person, organisation, institution, project or event record type, or is beyond the safety limit.',
      `deferred subject "${name}"`,
    );
  }

  // 3. Watch dates: the soonest first, undated last.
  const watch = [...extraction.watch_items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = a.item.trigger_date ?? '9999-12-31';
      const right = b.item.trigger_date ?? '9999-12-31';
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((entry) => entry.item);
  const watchItems = watch.slice(0, budget.watchItems);
  for (const dropped of watch.slice(budget.watchItems)) {
    keepInDocument(dropped.title, 'Beyond the dates kept above; it stays in your document.', `watch date "${dropped.title}"`);
  }

  // 4. Unknowns: a concern needing care outranks something merely unconfirmed.
  const risks = extraction.unknowns.filter((u) => u.kind === 'risk');
  const gaps = extraction.unknowns.filter((u) => u.kind === 'gap');
  const unknowns = [...risks.slice(0, budget.risks), ...gaps.slice(0, budget.gaps)];
  for (const dropped of [...risks.slice(budget.risks), ...gaps.slice(budget.gaps)]) {
    keepInDocument(
      dropped.statement.slice(0, 120),
      'The document also notes this; the review keeps the most significant ones.',
      `${dropped.kind} "${dropped.statement.slice(0, 60)}"`,
    );
  }

  // 5. Hypotheses: at most one, about a subject that survived, and the one that
  // belongs to the signal ranked highest -- not whichever the model listed first.
  const signalRank = new Map(signals.map((signal, index) => [signal.title.toLowerCase(), index]));
  const rankOfSignalFor = (hypothesis: { from_signal: string | null; about: string | null }) => {
    const byTitle = signalRank.get((hypothesis.from_signal ?? '').toLowerCase());
    if (byTitle !== undefined) return byTitle;
    const bySubject = signals.findIndex((signal) =>
      signal.subjects.some((s) => s.name.toLowerCase() === (hypothesis.about ?? '').toLowerCase()),
    );
    return bySubject === -1 ? Number.MAX_SAFE_INTEGER : bySubject;
  };
  const usable = extraction.hypotheses
    .filter((h) => !h.about || core.has(h.about.toLowerCase()))
    .map((hypothesis, index) => ({ hypothesis, index }))
    .sort((a, b) => {
      const left = rankOfSignalFor(a.hypothesis);
      const right = rankOfSignalFor(b.hypothesis);
      return left === right ? a.index - b.index : left - right;
    })
    .map((entry) => entry.hypothesis);
  const hypotheses = usable.slice(0, budget.hypotheses);
  for (const dropped of [...extraction.hypotheses.filter((h) => !usable.includes(h)), ...usable.slice(budget.hypotheses)]) {
    keepInDocument(dropped.title, 'An idea the document raises; only one unvalidated idea is offered at a time.', `hypothesis "${dropped.title}"`);
  }

  // 6. Research suggestions: at most one per kept signal, in signal order.
  // Suggesting three people from one story is noise; the question is which
  // signals would change with more knowledge.
  const signalFor = (subject: string) => {
    const name = subject.toLowerCase();
    const index = signals.findIndex(
      (signal) => signal.subjects.some((s) => s.name.toLowerCase() === name) || signal.title.toLowerCase().includes(name),
    );
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const claimed = new Set<number>();
  const research: typeof extraction.research_recommendations = [];
  const setAside: typeof extraction.research_recommendations = [];
  for (const recommendation of extraction.research_recommendations
    .map((item, index) => ({ item, index, signal: signalFor(item.subject) }))
    .sort((a, b) => (a.signal === b.signal ? a.index - b.index : a.signal - b.signal))) {
    const unclaimed = recommendation.signal !== Number.MAX_SAFE_INTEGER && !claimed.has(recommendation.signal);
    if (unclaimed && research.length < budget.researchRecommendations) {
      claimed.add(recommendation.signal);
      research.push(recommendation.item);
    } else {
      setAside.push(recommendation.item);
    }
  }
  for (const dropped of setAside) {
    trimmed.push(`research suggestion "${dropped.subject}"`);
  }

  return {
    extraction: {
      ...extraction,
      signals: trimmedSignals,
      watch_items: watchItems,
      unknowns,
      hypotheses,
      research_recommendations: research,
      source_only: sourceOnly,
    },
    trimmed,
  };
}
