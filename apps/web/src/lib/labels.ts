/**
 * The words the interface uses for records, fields and states.
 *
 * The database names things by how they are stored (`entities`,
 * `entity_affiliations`, `provenance_note`); people name them by what they are
 * (a person, a company, a role). Every screen that shows a proposed or saved
 * change takes its labels from here, so the same thing is called the same way
 * everywhere. Presentation only: nothing here changes what is stored.
 */

export type RecordKind =
  | 'Person'
  | 'Company'
  | 'Organisation'
  | 'Project'
  | 'Event'
  | 'Business unit'
  | 'Source'
  | 'Finding'
  | 'Relationship'
  | 'Signal'
  | 'Unconfirmed name'
  | 'Alternative name'
  | 'Research dossier'
  | 'Interaction'
  | 'Action'
  | 'Opportunity'
  | 'Outcome'
  | 'Research question'
  | 'Citation'
  | 'Record';

const ENTITY_TYPE_KIND: Record<string, RecordKind> = {
  person: 'Person',
  organization: 'Company',
  institution: 'Organisation',
  project: 'Project',
  event: 'Event',
  business_unit: 'Business unit',
  artifact: 'Research dossier',
  source: 'Source',
};

const TABLE_KIND: Record<string, RecordKind> = {
  evidence: 'Source',
  research_findings: 'Finding',
  entity_affiliations: 'Relationship',
  signals: 'Signal',
  signal_entities: 'Signal',
  entity_mentions: 'Unconfirmed name',
  entity_aliases: 'Alternative name',
  research_artifacts: 'Research dossier',
  interactions: 'Interaction',
  actions: 'Action',
  opportunities: 'Opportunity',
  research_topics: 'Research question',
  research_finding_evidence: 'Citation',
  outcomes: 'Outcome',
  business_units: 'Business unit',
};

/** What a proposed or saved record is, in plain words. */
export function recordKind(table: string, values?: Record<string, unknown> | null): RecordKind {
  if (table === 'entities') {
    const type = typeof values?.entity_type === 'string' ? values.entity_type : '';
    return ENTITY_TYPE_KIND[type] ?? 'Record';
  }
  return TABLE_KIND[table] ?? 'Record';
}

/** True for the kinds that are a subject other records hang off. */
export function isSubjectKind(kind: RecordKind): boolean {
  return ['Person', 'Company', 'Organisation', 'Project', 'Event', 'Business unit'].includes(kind);
}

/**
 * Fields that exist for the system rather than for the reader. They stay
 * available under "Details" on every change, never hidden from inspection.
 */
export const SYSTEM_FIELDS = new Set([
  'id',
  'workspace_id',
  'created_at',
  'updated_at',
  'slug',
  'alias_slug',
  'mention_slug',
  'visibility',
  'external_use_status',
  'sensitivity',
  'provenance_note',
  'capture_source',
  'created_from',
  'source_system',
  'source_reference',
  'legacy_business_unit_id',
]);

const FIELD_LABELS: Record<string, string> = {
  display_name: 'Name',
  entity_type: 'Type',
  description: 'Description',
  primary_url: 'Website',
  region: 'Region',
  country: 'Country',
  research_status: 'Research status',
  relationship_status: 'Relationship to Globa 3',
  relationship_confidence: 'Relationship confidence',
  status: 'Status',
  title: 'Title',
  url: 'Link',
  source_type: 'Source type',
  source_date: 'Source date',
  accessed_at: 'Accessed',
  reliability: 'Reliability',
  excerpt: 'Excerpt',
  notes: 'Notes',
  content: 'Content',
  finding_type: 'Kind of statement',
  confidence: 'Confidence',
  role_title: 'Role',
  context: 'Context',
  start_date: 'From',
  end_date: 'Until',
  is_primary: 'Primary role',
  is_current: 'Current',
  person_entity_id: 'Person',
  organization_entity_id: 'Organisation',
  related_entity_id: 'About',
  entity_id: 'About',
  candidate_entity_id: 'Possible match',
  evidence_id: 'Source',
  external_entity_id: 'With',
  source_evidence_id: 'Source',
  artifact_id: 'Dossier',
  source_artifact_id: 'Dossier',
  business_unit_id: 'Business unit',
  internal_business_unit_id: 'Business unit',
  signal_type: 'Signal type',
  why_it_matters: 'Why it matters',
  decision_question: 'Decision question',
  recommended_next_step: 'Recommended next step',
  original_claim: 'Original claim',
  signal_date: 'Date',
  signal_strength: 'Strength',
  priority: 'Priority',
  mention_text: 'Name as written',
  proposed_entity_type: 'Proposed type',
  proposed_display_name: 'Proposed name',
  resolution_status: 'Decision',
  rationale: 'Why it is unconfirmed',
  alias: 'Alternative name',
  alias_type: 'Kind of name',
  source_note: 'Note',
  summary: 'Summary',
  subject: 'Subject',
  occurred_at: 'Date',
  interaction_type: 'Interaction type',
  action_type: 'Action type',
  due_at: 'Due',
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const text = field.replace(/_id$/, '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Short plain-language meaning of each kind of claim. */
export const CLAIM_MEANING: Record<string, { label: string; meaning: string }> = {
  fact: { label: 'Fact', meaning: 'Stated by a source.' },
  inference: { label: 'Inference', meaning: 'Our reading of the sources; not stated directly.' },
  recommendation: { label: 'Recommendation', meaning: 'A suggested action, not a claim about the world.' },
  next_step: { label: 'Next step', meaning: 'A suggested action, not a claim about the world.' },
  gap: { label: 'Gap', meaning: 'Something we do not know yet.' },
  risk: { label: 'Risk', meaning: 'Something that could go wrong.' },
};

/** Proposal-level state, in the three words the product uses. */
export function proposalStatusLabel(status: string): string {
  switch (status) {
    case 'pending_review':
      return 'Awaiting review';
    case 'partially_applied':
      return 'Partly saved';
    case 'applied':
      return 'Saved';
    case 'rejected':
      return 'Rejected';
    case 'superseded':
      return 'Replaced';
    case 'draft':
      return 'Draft';
    default:
      return status.replace(/_/g, ' ');
  }
}

/** Item-level state. */
export function decisionLabel(decision: string, saved: boolean): string {
  if (saved) return 'Saved';
  if (decision === 'approved') return 'Approved';
  if (decision === 'rejected') return 'Rejected';
  return 'Awaiting review';
}

/** What an operation does, for the confirmation summary. */
export function opVerb(op: string): string {
  switch (op) {
    case 'create':
      return 'Create';
    case 'update':
      return 'Update';
    case 'link':
      return 'Link';
    case 'attach':
      return 'Attach';
    default:
      return op.charAt(0).toUpperCase() + op.slice(1);
  }
}

/** A run described by what it is doing for the user, not by its stage name. */
export function runKindLabel(kind: string): string {
  switch (kind) {
    case 'brief':
      return 'Brief';
    case 'research':
      return 'Research';
    case 'ingest':
      return 'Upload';
    case 'report':
      return 'Daily report';
    case 'ask':
      return 'Question';
    default:
      return kind;
  }
}

/** Honest status of an uploaded file that has not been read into memory yet. */
export const UPLOAD_REFERENCE_NOTE = 'Stored for reference. Capture it to read it into memory.';

/** A coverage window in the workspace timezone, instead of ISO/UTC strings. */
export function formatWindow(startIso: string | null, endIso: string | null, timeZone: string): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${format.format(start)} – ${format.format(end)} (${timeZone})`;
}

/** Fields whose values are codes (`research_only`, `url`), shown as words. */
const CODE_FIELDS = new Set([
  'research_status',
  'relationship_status',
  'relationship_confidence',
  'status',
  'source_type',
  'reliability',
  'confidence',
  'finding_type',
  'signal_type',
  'signal_strength',
  'priority',
  'alias_type',
  'resolution_status',
  'proposed_entity_type',
  'interaction_type',
  'interaction_direction',
  'action_type',
  'artifact_type',
]);

const INTERACTION_TYPE_LABELS: Record<string, string> = {
  introduction: 'Introduction',
  encounter: 'Met',
  meeting: 'Meeting',
  call: 'Call',
  conversation: 'Conversation',
  email: 'Email',
  message: 'Message',
  event: 'Event',
};

export function humanValue(field: string | undefined, value: string): string {
  if (!field || !CODE_FIELDS.has(field) || !/^[a-z0-9_]+$/.test(value)) return value;
  if (field === 'proposed_entity_type') return recordKind('entities', { entity_type: value });
  if (field === 'relationship_status' && value === 'contact') return 'External contact';
  if (field === 'interaction_type' && INTERACTION_TYPE_LABELS[value]) return INTERACTION_TYPE_LABELS[value]!;
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Record labels as stored may use ASCII arrows ("A -> B"). */
export function displayLabel(label: string): string {
  return label.replace(/\s->\s/g, ' → ');
}

/** Where a proposal came from, as a person would say it. */
export function proposalSourceLabel(sourceKind: string): string {
  switch (sourceKind) {
    case 'capture':
      return 'From a capture';
    case 'research':
      return 'From research you requested';
    case 'brief':
      return 'From an earlier brief';
    case 'upload':
      return 'From an uploaded file';
    case 'manual':
      return 'Entered by hand';
    default:
      return 'Proposed';
  }
}

/**
 * What a saved record is, in the words a person would use. The record kinds
 * above name storage; this names the thing itself, for Today and the phone.
 */
const PLAIN_KIND: Record<string, string> = {
  Source: 'Your note',
  Person: 'Contact',
  Company: 'Company',
  Organisation: 'Organisation',
  Project: 'Project',
  Event: 'Event',
  Relationship: 'Role at a company',
  Interaction: 'What happened',
  Action: 'Follow-up',
  Finding: 'Something we know',
  Opportunity: 'Opportunity',
  'Unconfirmed name': 'Possible match',
  'Alternative name': 'Contact detail',
  Signal: 'Signal',
  'Business unit': 'Business unit',
};

export function plainKind(kind: string): string {
  return PLAIN_KIND[kind] ?? kind;
}

/** Titles keep the note's own words: the "Capture:" prefix is for storage. */
export function plainTitle(label: string): string {
  return displayLabel(label).replace(/^Capture:\s*/i, '');
}
