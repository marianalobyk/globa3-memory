/**
 * Is this answer's briefing one the web client can render?
 *
 * Same rule as the phone (apps/mobile/src/briefing-view.ts): a briefing that is
 * missing, from an older server shape, or half-formed falls back to the
 * ordinary grounded answer instead of breaking the page.
 * scripts/test-readback-fallback.mjs holds the two in step.
 */
export interface BriefingLine {
  text: string;
  note: string | null;
}

export interface Briefing {
  name: string;
  subtitle: string | null;
  lead: string | null;
  sections: { key: string; heading: string; lines: BriefingLine[] }[];
  sources: { label: string; kind: string; date: string | null }[];
}

export function usableBriefing(answer: { briefing?: unknown } | null | undefined): Briefing | null {
  const briefing = answer?.briefing as (Partial<Briefing> & Record<string, unknown>) | null | undefined;
  if (!briefing || typeof briefing !== 'object') return null;
  if (typeof briefing.name !== 'string' || briefing.name.trim().length === 0) return null;

  const sections = (Array.isArray(briefing.sections) ? briefing.sections : [])
    .filter(
      (section): section is Briefing['sections'][number] =>
        Boolean(section) && typeof section === 'object' && typeof section.heading === 'string' && Array.isArray(section.lines),
    )
    .map((section) => ({
      ...section,
      lines: section.lines.filter((line) => Boolean(line) && typeof line.text === 'string'),
    }))
    .filter((section) => section.lines.length > 0);

  const lead = typeof briefing.lead === 'string' && briefing.lead.trim().length > 0 ? briefing.lead : null;
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
