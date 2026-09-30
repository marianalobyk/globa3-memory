/**
 * Is this answer's briefing one this app can render?
 *
 * The app and the server are deployed separately, so a client can meet an older
 * server (or a newer one): a briefing may be missing, may be an older shape
 * without sections, or may arrive half-formed. Rendering is never a good place
 * to find that out, so the answer is checked here and the screen falls back to
 * the ordinary grounded answer whenever anything is missing.
 *
 * The web client applies the same rule (apps/web/src/lib/briefing-view.ts), and
 * scripts/test-readback-fallback.mjs holds them to the same verdicts.
 */
import type { AskAnswer, SubjectBriefing } from './types';

type Loose = Partial<SubjectBriefing> & Record<string, unknown>;

export function usableBriefing(answer: Pick<AskAnswer, 'briefing'> | null | undefined): SubjectBriefing | null {
  const briefing = answer?.briefing as Loose | null | undefined;
  if (!briefing || typeof briefing !== 'object') return null;
  if (typeof briefing.name !== 'string' || briefing.name.trim().length === 0) return null;

  const sections = (Array.isArray(briefing.sections) ? briefing.sections : [])
    .filter((section): section is SubjectBriefing['sections'][number] =>
      Boolean(section) && typeof section === 'object' && typeof section.heading === 'string' && Array.isArray(section.lines),
    )
    .map((section) => ({
      ...section,
      lines: section.lines.filter((line) => Boolean(line) && typeof line.text === 'string'),
    }))
    .filter((section) => section.lines.length > 0);

  const lead = typeof briefing.lead === 'string' && briefing.lead.trim().length > 0 ? briefing.lead : null;
  // An older server sends a briefing with no sections and no lead: nothing to
  // render, so the ordinary answer is shown instead.
  if (sections.length === 0 && !lead) return null;

  return {
    name: briefing.name,
    subtitle: typeof briefing.subtitle === 'string' ? briefing.subtitle : null,
    lead,
    sections,
    sources: (Array.isArray(briefing.sources) ? briefing.sources : []).filter(
      (source) => Boolean(source) && typeof source.label === 'string',
    ),
  };
}
