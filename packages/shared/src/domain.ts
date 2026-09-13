/** Row-level domain types shared by the web app and the worker. */

export type RunKind = 'brief' | 'research' | 'ask' | 'ingest' | 'report';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export type ProposalStatus =
  | 'draft'
  | 'pending_review'
  | 'partially_applied'
  | 'applied'
  | 'rejected'
  | 'superseded';

export type ProposalOp = 'create' | 'update' | 'link' | 'attach' | 'skip';
export type MatchStatus = 'new' | 'existing' | 'ambiguous';
export type ItemDecision = 'pending' | 'approved' | 'rejected';

export type QaStatus =
  | 'pass_internal_only'
  | 'pass_quiet_window_internal_only'
  | 'review_internal_only'
  | 'fail_do_not_distribute'
  | 'not_run';

export type UploadStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'parsed'
  | 'failed'
  | 'skipped'
  | 'rejected';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface WorkspaceAccess {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  timezone: string;
  role: WorkspaceRole;
  canApprove: boolean;
}

export interface Session {
  user: SessionUser;
  workspaces: WorkspaceAccess[];
  activeWorkspace: WorkspaceAccess;
  /** True when the dev auth provider issued this session instead of Supabase. */
  isDevAuth: boolean;
}

export interface EntityCandidate {
  id: string;
  displayName: string;
  entityType: string;
  slug: string;
  similarity: number;
  matchedVia: 'slug' | 'alias' | 'name_similarity' | 'acronym' | 'mention';
  researchStatus: string | null;
  relationshipStatus: string | null;
  note: string | null;
}

export interface ResolutionResult {
  query: string;
  entityType: string;
  status: MatchStatus;
  best: EntityCandidate | null;
  candidates: EntityCandidate[];
  /** Why the resolver decided this, shown verbatim in the Review screen. */
  rationale: string;
}

export interface CostSummary {
  totalUsd: number;
  /** True when any component of the total was estimated rather than reported. */
  hasEstimates: boolean;
  byStage: { stage: string; usd: number; isEstimate: boolean }[];
  byModel: { model: string; usd: number; tokensIn: number; tokensOut: number }[];
}

export const PROPOSAL_TARGET_TABLES = [
  'entities',
  'entity_aliases',
  'entity_affiliations',
  'entity_mentions',
  'evidence',
  'research_artifacts',
  'research_findings',
  'interactions',
  'actions',
  'signals',
  'signal_entities',
  'opportunities',
  'outcomes',
  'knowledge',
  'rules',
] as const;

export type ProposalTargetTable = (typeof PROPOSAL_TARGET_TABLES)[number];
