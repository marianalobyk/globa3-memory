/**
 * Response shapes of the server endpoints the app calls.
 *
 * These mirror apps/web/src/lib/capture-view.ts and the mobile routes. They are
 * declared here, not imported, because the app must not pull server modules
 * into its bundle (metro.config.js blocks them). The API test
 * (scripts/test-mobile-api.mjs) checks the server still returns these fields.
 */

export interface SessionInfo {
  user: { email: string; displayName: string | null };
  workspace: {
    id: string;
    name: string;
    timezone: string;
    role: 'admin' | 'editor' | 'viewer';
    canApprove: boolean;
    isAdmin: boolean;
  };
  workspaces: { id: string; name: string }[];
  isDevAuth: boolean;
  aiMode: 'live' | 'mock';
}

export interface SavedRecord {
  label: string;
  kind: string;
  verb: string;
  savedAt: string;
}

export interface TodayView {
  date: string;
  awaiting: { proposals: number; changes: number };
  decisions: {
    proposalId: string;
    title: string;
    sourceLabel: string;
    awaiting: number;
    createdAt: string;
    isMock: boolean;
  }[];
  analysing: { captureId: string | null; title: string; phaseLabel: string; failed: boolean; createdAt: string }[];
  savedTitle: string;
  savedToday: number;
  saved: (SavedRecord & { proposalId: string })[];
}

export type CapturePhase = 'received' | 'analysing' | 'matching' | 'ready' | 'failed' | 'withdrawn';

export interface CaptureView {
  id: string;
  kind: 'text' | 'url' | 'file';
  phase: CapturePhase;
  phaseLabel: string;
  steps: { label: string; state: 'done' | 'current' | 'todo' | 'failed' }[];
  failure: string | null;
  canRetry: boolean;
  capturedAt: string;
  source: { text: string | null; filename: string | null; url: string | null };
  proposal: { id: string; title: string; summary: string; changes: number; awaiting: number; saved: number } | null;
  isMock: boolean;
}

export type MatchView = 'existing' | 'new' | 'ambiguous';

export interface ProposedChange {
  id: string;
  number: number;
  action: string;
  kind: string;
  title: string;
  text: string | null;
  details: { label: string; value: string }[];
  claim: { label: string; meaning: string } | null;
  confidence: string | null;
  match: MatchView | null;
  matchNote: string | null;
  candidates: { name: string; similarity: number | null }[];
  decision: 'pending' | 'approved' | 'rejected';
  saved: boolean;
  needsAttention: string | null;
  needs: number[];
  kindLabel: string;
  inContactCard: boolean;
  fromResearch: boolean;
  sources: string[];
}

export interface IdentityCandidate {
  index: number;
  name: string;
  organization: string | null;
  role: string | null;
  location: string | null;
  explanation: string;
  matches: string[];
  conflicts: string[];
  nameOnly: boolean;
  confidence: string;
  sources: { url: string; title: string | null }[];
}

export interface ContactResearch {
  status:
    | 'not_started'
    | 'identifying'
    | 'awaiting_confirmation'
    | 'no_reliable_match'
    | 'none_of_these'
    | 'needs_context'
    | 'researching'
    | 'completed'
    | 'failed';
  statusLabel: string;
  message: string | null;
  active: boolean;
  candidates: IdentityCandidate[];
  confirmed: { name: string; organization: string | null; role: string | null } | null;
  itemsAdded: number;
}

export interface ContactCard {
  key: string;
  name: string;
  important: boolean;
  researchReasons: string[];
  research: ContactResearch | null;
  fromResearch: string[];
  match: MatchView;
  matchLabel: string;
  needsMoreInfo: boolean;
  candidates: { name: string; similarity: number | null }[];
  fromNote: string[];
  missing: { label: string; value: string }[];
  basicChangeIds: string[];
  entityId: string | null;
}

export interface ProposalView {
  id: string;
  title: string;
  summary: string | null;
  statusLabel: string;
  version: number;
  isMock: boolean;
  sourceLabel: string;
  canApprove: boolean;
  capture: { id: string; text: string | null; filename: string | null; url: string | null; capturedAt: string } | null;
  counts: { total: number; awaiting: number; approved: number; saved: number; rejected: number };
  groups: { band: string; label: string; note: string | null; changes: ProposedChange[] }[];
  mentions: {
    name: string;
    kind: string;
    match: MatchView;
    note: string;
    candidates: { name: string; similarity: number | null }[];
    entityId: string | null;
  }[];
  contacts: ContactCard[];
  researchActive: boolean;
  saved: SavedRecord[];
  researchable: { label: string; kind: 'person' | 'company' | 'project'; entityId: string | null }[];
  /** "Here is what I understood". Null only for proposals that did not come from a capture. */
  confirmation: Confirmation | null;
}

export type ConfirmationStatus = 'ready' | 'researching' | 'choose_identity' | 'needs_context' | 'saved' | 'closed';

export interface DocumentReview {
  title: string;
  readAs: string;
  summary: string;
  headline: string;
  groups: {
    key: 'save' | 'research' | 'source_only' | 'unclear';
    label: string;
    why: string;
    lines: DocumentLine[];
  }[];
}

export interface DocumentLine {
  text: string;
  detail: string | null;
  itemId: string | null;
  /** A choice: nothing is saved unless it is turned on. */
  optional: { toggleLabel: string; itemIds: string[] } | null;
}

/** The human summary of a capture, decided by the server. */
export interface Confirmation {
  kind: 'contact' | 'document';
  document: DocumentReview | null;
  status: ConfirmationStatus;
  statusLabel: string;
  contact: { key: string; label: string; name: string; line: string | null; similarTo: string[] } | null;
  others: string[];
  context: string | null;
  missing: string | null;
  followUps: string[];
  primaryActionLabel: string;
  canResearch: boolean;
  researchFound: {
    confirmedAs: string | null;
    profiles: { label: string; url: string }[];
    facts: { text: string; sources: string[] }[];
    readings: { label: 'Inference' | 'Suggestion' | 'Still unknown'; text: string; basis: string | null; sources: string[] }[];
  } | null;
  save: { lines: string[]; optional: string[]; keepsNote: boolean; itemIds: string[] };
  summary: string;
}

export interface ReviewList {
  proposals: {
    proposalId: string;
    title: string;
    /** Who the capture is about, or its title. */
    name: string;
    summary: string | null;
    status: ConfirmationStatus;
    statusLabel: string;
    sourceLabel: string;
    awaiting: number;
    saved: number;
    createdAt: string;
    isMock: boolean;
  }[];
}

/** A briefing built from approved records, in reading order. */
export interface SubjectBriefing {
  name: string;
  subtitle: string | null;
  lead: string | null;
  sections: { key: 'known' | 'why' | 'watch' | 'unconfirmed'; heading: string; lines: { text: string; note: string | null }[] }[];
  sources: { label: string; kind: string; date: string | null }[];
}

export interface AskAnswer {
  briefing: SubjectBriefing | null;
  answerMd: string;
  citations: { row_id: string; label: string; kind: string; quote: string | null }[];
  unanswered: string[];
  retrievedCount: number;
  isMock: boolean;
}

/** The privacy preflight shown before any contact research. */
export interface ResearchPreflight {
  contactKey: string;
  contactName: string;
  clues: { id: string; kind: string; label: string; value: string; required: boolean }[];
  withheld: { label: string; inThisCapture: boolean }[];
  statement: string;
}
