/**
 * A research document (a radar, a brief, a dossier) mapped onto proposed records.
 *
 * A document is not a relationship. Nobody named in it becomes a contact, and
 * nothing in it is researched. What it produces is:
 *
 *   evidence            the document itself, kept as the source it is
 *   research_artifacts  the document as an object, with its cited sources
 *   signals             only the decision-relevant items, with why they matter
 *   signal_entities     the people, companies and projects each signal needs
 *   entities            those subjects, as plain records (relationship_status 'none')
 *   actions             forward-watch dates, as watch items
 *   research_findings   what is unknown (gap) and what needs care (risk)
 *   opportunities       an explicitly unvalidated hypothesis, only when selected
 *
 * Deliberately NOT produced: one evidence row per cited URL (they ride as
 * provenance), event records for festivals or dates, contacts, and anything at
 * all for routine results and exclusions -- those stay in the document, and the
 * review says so.
 */
import { slugify, type DocumentExtraction, type ProposedChange } from '@g3/shared';
import type { CaptureProposal } from '@g3/shared';
import type { CaptureResolution } from './capture.js';

export interface DocumentProposalInput {
  extraction: DocumentExtraction;
  resolutions: CaptureResolution[];
  source: {
    captureId: string;
    kind: 'text' | 'url' | 'file';
    filename: string | null;
    sourceUrl: string | null;
    capturedOn: string;
  };
  excerpt: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string | null | undefined): string | null => (value && DATE_ONLY.test(value) ? value : null);

const EVIDENCE_SOURCE_TYPE: Record<string, string> = {
  radar_brief: 'brief',
  research_brief: 'brief',
  dossier: 'dossier',
  report: 'brief',
  other: 'other',
};

/**
 * Captures may be Markdown, but the records derived from them are plain text.
 * In particular, emphasis around a project title must not become part of its
 * canonical name in memory.
 */
function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*{1,3})([^*]+)\1/g, '$2')
    .replace(/\\([`*\[\]()])/g, '$1')
    .trim();
}

const RAW_SOURCE_FIELDS = new Set(['url', 'file_reference', 'source_reference', 'excerpt']);

/** Concerns that need care, whatever the model called them. */
const RISK_WORDS = /\b(safeguard\w*|consent|trauma|minor|child|wellbeing|well-being|reputation\w*|legal|defamation|litigation|privacy|security|harm)\b/i;

export function documentProposalFromExtraction(input: DocumentProposalInput): CaptureProposal {
  const { extraction, resolutions, source } = input;
  const changes: ProposedChange[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  const label = (text: string, suffix: string): string => {
    let candidate = plainText(text).slice(0, 200) || suffix;
    if (used.has(candidate.toLowerCase())) candidate = `${candidate} (${suffix})`;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${plainText(text).slice(0, 180)} (${suffix} ${n++})`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const field = (name: string, value: string | null | undefined) => ({
    name,
    value: value === null || value === undefined || RAW_SOURCE_FIELDS.has(name) ? value ?? null : plainText(value),
  });
  const bySlug = new Map(resolutions.map((r) => [slugify(r.name), r]));

  // -- The document itself --------------------------------------------------
  const artifact = { ...extraction.artifact, title: plainText(extraction.artifact.title) };
  const documentDate = validDate(artifact.document_date) ?? source.capturedOn;
  const citedSources = artifact.source_urls.filter((u) => /^https?:\/\//.test(u)).slice(0, 40);
  const evidenceLabel = label(`${artifact.title} (captured file)`, 'source');
  changes.push({
    op: 'create',
    target_table: 'evidence',
    label: evidenceLabel,
    claim_type: 'fact',
    confidence: 'high',
    reason: 'The document you captured, kept as the source it is. Everything below cites it.',
    fields: [
      field('source_type', EVIDENCE_SOURCE_TYPE[artifact.artifact_type] ?? 'other'),
      field('title', evidenceLabel),
      field('file_reference', source.filename ? `capture:${source.captureId}:${source.filename}` : `capture:${source.captureId}`),
      field('url', source.sourceUrl),
      field('source_date', documentDate),
      field('accessed_at', source.capturedOn),
      field('reliability', 'unverified'),
      field('excerpt', input.excerpt.slice(0, 1_500)),
      field(
        'notes',
        [
          artifact.summary,
          artifact.coverage ? `Coverage stated in the document: ${artifact.coverage}.` : null,
          artifact.external_use ? `External-use status stated in the document: ${artifact.external_use}.` : null,
          'Stored as captured. Its own claims are not promoted to verified.',
        ]
          .filter(Boolean)
          .join(' '),
      ),
      field('visibility', 'internal'),
      field('external_use_status', 'not_cleared'),
      field('sensitivity', 'standard'),
      field('provenance_note', `Captured on ${source.capturedOn}.`),
    ],
    source_urls: citedSources,
  });

  const artifactLabel = label(artifact.title, 'document');  // keeps the document's own title
  changes.push({
    op: 'create',
    target_table: 'research_artifacts',
    label: artifactLabel,
    claim_type: 'fact',
    confidence: 'high',
    reason: 'The document as a whole, so everything it supports stays traceable to it.',
    fields: [
      field('title', artifactLabel),
      field('artifact_type', artifact.artifact_type),
      field('summary', artifact.summary),
      field('source_evidence_label', evidenceLabel),
      field('capture_source', 'capture'),
      field('source_file', source.filename),
      field('status', 'active'),
      field('visibility', 'internal'),
      field('external_use_status', 'not_cleared'),
      field('sensitivity', 'standard'),
      field(
        'provenance_note',
        [
          `Document date: ${documentDate}.`,
          artifact.coverage ? `Coverage: ${artifact.coverage}.` : null,
          citedSources.length > 0 ? `Cited sources: ${citedSources.join(', ')}` : 'The document cites no sources.',
        ]
          .filter(Boolean)
          .join(' '),
      ),
    ],
    source_urls: citedSources,
  });

  // -- Subjects: plain records, never contacts ------------------------------
  const entityLabels = new Map<string, string>();
  const ambiguous = new Set<string>();
  const ENTITY_TYPE: Record<string, string> = {
    person: 'person',
    organization: 'organization',
    project: 'project',
    institution: 'institution',
    event: 'event',
    other: 'other',
  };
  const referenceFor = (name: string): string | null => {
    const resolution = bySlug.get(slugify(name));
    if (!resolution) return null;
    if (resolution.status === 'existing' && resolution.best) return resolution.best.displayName;
    if (resolution.status === 'new') return entityLabels.get(slugify(name)) ?? null;
    ambiguous.add(resolution.name);
    return null;
  };

  // A `subject` is deliberately broader than the literal topic of the signal:
  // it is a decision-relevant person, company, project or institution. The
  // extraction prompt reserves `organisation` and `mentioned` for contextual
  // names, so a long radar does not turn every publisher or platform into
  // memory just because it was named once.
  const needed = new Map<string, { name: string; kind: string }>();
  for (const signal of extraction.signals) {
    for (const subject of signal.subjects) {
      if (subject.role !== 'subject') continue;
      const key = slugify(subject.name);
      if (key && !needed.has(key)) needed.set(key, { name: subject.name, kind: subject.kind });
    }
  }
  for (const [key, subject] of needed) {
    const resolution = bySlug.get(key);
    if (!resolution) continue;
    if (resolution.status === 'new') {
      const entityLabel = label(subject.name, 'record');
      entityLabels.set(key, entityLabel);
      changes.push({
        op: 'create',
        target_table: 'entities',
        label: entityLabel,
        claim_type: 'fact',
        confidence: 'medium',
        reason: `Named in the document as a subject of a signal. Saved as a record to attach that signal to, not as a contact: nothing here says you know them.`,
        fields: [
          field('entity_type', ENTITY_TYPE[subject.kind] ?? 'other'),
          field('display_name', plainText(subject.name)),
          field('research_status', 'unverified'),
          // A document mention is not a relationship.
          field('relationship_status', 'none'),
          field('source_evidence_label', evidenceLabel),
          field('capture_source', 'capture'),
          field('visibility', 'internal'),
          field('external_use_status', 'not_cleared'),
        ],
        source_urls: [],
      });
    } else if (resolution.status === 'ambiguous') {
      ambiguous.add(resolution.name);
      changes.push({
        op: 'create',
        target_table: 'entity_mentions',
        label: label(resolution.name, 'unconfirmed name'),
        claim_type: 'gap',
        confidence: 'low',
        reason: `"${resolution.name}" is close to a name already in memory. A similar name is not the same record, so it is staged for a person to decide.`,
        fields: [
          field('mention_text', resolution.name),
          field('proposed_entity_type', ENTITY_TYPE[subject.kind] ?? 'other'),
          field('proposed_display_name', resolution.name),
          field('resolution_status', 'pending'),
          field('confidence', 'low'),
          field('rationale', resolution.rationale),
          field('created_from', 'capture_document'),
        ],
        source_urls: [],
      });
    }
  }

  // -- Signals, and the entities each one needs -----------------------------
  const signalLabels = new Map<string, string>();
  for (const signal of extraction.signals) {
    const primary = signal.subjects.find((s) => s.role === 'subject') ?? signal.subjects[0] ?? null;
    const primaryRef = primary ? referenceFor(primary.name) : null;
    const signalLabel = label(signal.title, 'signal');
    signalLabels.set(signal.title.toLowerCase(), signalLabel);
    const signalSources = signal.source_urls.filter((u) => /^https?:\/\//.test(u)).slice(0, 10);
    changes.push({
      op: 'create',
      target_table: 'signals',
      label: signalLabel,
      claim_type: 'fact',
      confidence: signal.confidence,
      reason: `Why this matters now, as the document argues it.${primary && !primaryRef ? ` Not linked to "${primary.name}": that name is not confirmed yet.` : ''}`,
      fields: [
        field('signal_type', signal.signal_type),
        field('title', signalLabel),
        field('description', signal.what_changed),
        field('why_it_matters', signal.why_it_matters),
        field('decision_question', signal.decision_question),
        field('recommended_next_step', signal.recommended_next_step),
        field('promotion_trigger', signal.promotion_trigger),
        field('priority', signal.priority),
        field('confidence', signal.confidence),
        field('signal_strength', signal.priority),
        field('original_claim', signal.original_claim),
        field('signal_date', documentDate),
        field('related_entity_label', primaryRef),
        field('evidence_label', evidenceLabel),
        field('status', 'watch'),
        field('visibility', 'internal'),
        field('external_use_status', 'not_cleared'),
        field('provenance_note', signalSources.length > 0 ? `Cited sources: ${signalSources.join(', ')}` : `From ${artifact.title}.`),
      ],
      source_urls: signalSources,
    });

    for (const subject of signal.subjects) {
      const reference = referenceFor(subject.name);
      if (!reference) continue;
      changes.push({
        op: 'link',
        target_table: 'signal_entities',
        label: label(`${signalLabel} → ${subject.name}`, 'link'),
        claim_type: 'fact',
        confidence: signal.confidence,
        reason: `${subject.name} is ${subject.role === 'subject' ? 'what this signal is about' : subject.role === 'organisation' ? 'the organisation involved' : 'named in this signal'}.`,
        fields: [
          field('signal_label', signalLabel),
          field('entity_label', reference),
          field('role', subject.role === 'organisation' ? 'organisation' : subject.role),
          field('confidence', signal.confidence),
          field('notes', `From ${artifact.title}.`),
        ],
        source_urls: [],
      });
    }

    // A signal explains why something matters. Its source facts preserve the
    // concrete, checkable detail needed to read that signal back later.
    for (const fact of (signal.source_facts ?? []).slice(0, 1)) {
      const about = fact.about ? referenceFor(fact.about) : primaryRef;
      // A fact is stored under the signal it explains. This makes neighbouring
      // facts from a dense radar distinguishable in review and readback.
      const factTitle = primary
        ? `${plainText(primary.name)}: ${plainText(fact.statement)}`
        : plainText(fact.statement);
      const factLabel = label(factTitle.slice(0, 160), 'source fact');
      changes.push({
        op: 'create',
        target_table: 'research_findings',
        label: factLabel,
        claim_type: 'fact',
        confidence: fact.confidence,
        reason: 'A checkable fact stated in the document, kept with its source so it can be read back later.',
        fields: [
          field('finding_type', 'fact'),
          field('title', factLabel),
          field('content', fact.statement),
          field('confidence', fact.confidence),
          field('related_entity_label', about),
          field('artifact_label', artifactLabel),
          field('evidence_label', evidenceLabel),
          field('visibility', 'internal'),
          field('external_use_status', 'not_cleared'),
          field('provenance_note', `Stated in ${artifact.title} on ${documentDate}.`),
        ],
        source_urls: signalSources,
      });
    }
  }

  // -- Forward watch --------------------------------------------------------
  for (const watch of extraction.watch_items) {
    const about = watch.about ? referenceFor(watch.about) : null;
    const watchLabel = label(`Watch: ${watch.title}`, 'watch');
    changes.push({
      op: 'create',
      target_table: 'actions',
      label: watchLabel,
      claim_type: 'recommendation',
      confidence: 'medium',
      reason: 'A date the document says to come back to. Saving it puts it on your list; nothing happens automatically.',
      fields: [
        field('action_type', 'watch'),
        field('title', watchLabel),
        field(
          'description',
          [watch.why_it_matters, watch.promotion_condition ? `Promote only if: ${watch.promotion_condition}` : null].filter(Boolean).join('\n\n'),
        ),
        field('due_at', validDate(watch.trigger_date)),
        field('priority', watch.priority),
        field('status', 'proposed'),
        field('related_entity_label', about),
        field('evidence_label', evidenceLabel),
        field('source_system', 'capture'),
        field('source_reference', source.captureId),
        field('visibility', 'internal'),
        field('external_use_status', 'not_cleared'),
      ],
      source_urls: [],
    });
  }

  // -- What is unknown, and what needs care ---------------------------------
  for (const unknown of extraction.unknowns) {
    // The document's own wording decides, with a safety net: a concern that
    // names safeguarding, consent or legal exposure is a risk, not a gap.
    const kind = unknown.kind === 'risk' || RISK_WORDS.test(`${unknown.statement} ${unknown.why_it_matters}`) ? 'risk' : 'gap';
    const about = unknown.about ? referenceFor(unknown.about) : null;
    const findingLabel = label(unknown.statement.slice(0, 160), kind);
    changes.push({
      op: 'create',
      target_table: 'research_findings',
      label: findingLabel,
      claim_type: kind,
      confidence: kind === 'risk' ? 'medium' : 'low',
      reason:
        kind === 'risk'
          ? 'A concern the document raises that needs care before anything is acted on.'
          : 'Something the document says is not known or not confirmed.',
      fields: [
        field('finding_type', kind),
        field('title', findingLabel),
        field('content', `${unknown.statement}\n\nWhy it matters: ${unknown.why_it_matters}`),
        field('confidence', kind === 'risk' ? 'medium' : 'low'),
        field('related_entity_label', about),
        field('artifact_label', artifactLabel),
        field('evidence_label', evidenceLabel),
        field('visibility', 'internal'),
        field('external_use_status', 'not_cleared'),
        field('provenance_note', `From ${artifact.title} on ${documentDate}.`),
      ],
      source_urls: [],
    });
  }

  // -- Ideas the document did not confirm -----------------------------------
  for (const hypothesis of extraction.hypotheses) {
    const about = hypothesis.about ? referenceFor(hypothesis.about) : null;
    const fromSignal = hypothesis.from_signal ? signalLabels.get(hypothesis.from_signal.toLowerCase()) ?? null : null;
    const hypothesisLabel = label(hypothesis.title, 'idea');
    changes.push({
      op: 'create',
      target_table: 'opportunities',
      label: hypothesisLabel,
      claim_type: 'inference',
      confidence: 'low',
      reason: 'An idea the document raises without confirming it. It is saved only if you choose to keep it, and stays marked as unvalidated.',
      fields: [
        field('title', hypothesisLabel),
        field(
          'description',
          `Unvalidated hypothesis. ${hypothesis.description}\n\nNo partner, funding, rights, mechanics or launch date is confirmed.`,
        ),
        field('opportunity_type', 'hypothesis'),
        field('stage', 'idea'),
        field('priority', 'low'),
        field('related_entity_label', about),
        field('source_signal_label', fromSignal),
        field('evidence_label', evidenceLabel),
        field('status', 'active'),
        field('visibility', 'internal'),
        field('external_use_status', 'not_cleared'),
        field('provenance_note', 'Raised as a hypothesis in a research document; nothing about it is confirmed.'),
      ],
      source_urls: [],
    });
  }

  // -- Questions worth researching ------------------------------------------
  //
  // Offered, never acted on. Each becomes a `research_topics` item that is off
  // by default: a capture approved without it writes nothing, and selecting it
  // only records the question. The search itself needs the separate
  // confirmation in topic-research.ts.
  for (const recommendation of extraction.research_recommendations) {
    const about = referenceFor(recommendation.subject);
    const questionLabel = label(`Research: ${recommendation.subject}`, 'research');
    changes.push({
      op: 'create',
      target_table: 'research_topics',
      label: questionLabel,
      claim_type: null,
      confidence: null,
      reason: 'A question this material leaves open. Choosing it records the question; nothing is searched until you confirm it separately.',
      fields: [
        field('label', recommendation.subject),
        field('research_question', recommendation.why),
        field('why_useful', recommendation.why),
        field('target_type', 'topic'),
        field('priority', 'medium'),
        field('status', 'proposed'),
        field('selected', 'false'),
        field('matched_entity_label', about),
      ],
      source_urls: [],
    });
  }

  if (extraction.source_only.length > 0) {
    notes.push(
      `${extraction.source_only.length} item(s) stay in the document only: ${extraction.source_only.map((s) => s.label).join('; ')}.`,
    );
  }
  if (ambiguous.size > 0) {
    notes.push(`${[...ambiguous].join(', ')} could be someone already in memory, so nothing was linked to them.`);
  }

  return {
    title: artifact.title,
    summary: artifact.summary,
    changes,
    notes,
    unresolved_mentions: resolutions
      .filter((r) => r.status === 'ambiguous')
      .map((r) => ({
        name: r.name,
        entity_type: r.kind,
        possible_matches: r.candidates.map((c) => c.displayName),
        why_unresolved: r.rationale,
      })),
  };
}
