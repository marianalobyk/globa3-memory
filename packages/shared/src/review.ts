/**
 * How a proposed change is presented for review, shared by every client.
 *
 * Within a proposal, changes are separated by what kind of statement they are:
 * a fact the source states and our own reading of it must never look alike.
 * The web review screen and the mobile API both classify with this function,
 * so the two clients can never disagree about which group a change belongs to.
 */

export type ReviewBand = 'record' | 'fact' | 'inference' | 'followup' | 'gap';

export const REVIEW_BAND_ORDER: ReviewBand[] = ['record', 'fact', 'inference', 'followup', 'gap'];

export const REVIEW_BANDS: Record<ReviewBand, { label: string; note: string | null }> = {
  record: { label: 'People, companies and links', note: null },
  fact: { label: 'Stated in the source', note: 'Written down as the source put it.' },
  inference: {
    label: 'Our reading, not stated directly',
    note: 'Nobody said this; it was inferred from the source.',
  },
  followup: { label: 'Suggested follow-ups', note: 'A proposed next step, not a claim about the world.' },
  gap: { label: 'Still unknown', note: 'Recorded as an open question.' },
};

/**
 * The band for one proposed change, from its target table and claim type.
 *
 * Findings are banded by claim type. Actions are follow-ups. Everything else --
 * people, companies, projects, interactions, relationships, opportunity links,
 * the source record itself -- is a record or link; those still carry their own
 * claim type (an inferred relationship is labelled as an inference on the item).
 */
export function reviewBand(targetTable: string, claimType: string | null | undefined): ReviewBand {
  if (targetTable === 'actions') return 'followup';
  if (targetTable !== 'research_findings') return 'record';
  switch (claimType) {
    case 'inference':
      return 'inference';
    case 'recommendation':
    case 'next_step':
      return 'followup';
    case 'gap':
      return 'gap';
    default:
      return 'fact';
  }
}

/** Where a capture is in its analysis, in the words a person reads. */
export type CapturePhase = 'received' | 'analysing' | 'matching' | 'ready' | 'failed' | 'withdrawn';

export const CAPTURE_PHASES: Record<CapturePhase, string> = {
  received: 'Received',
  analysing: 'Analysing',
  matching: 'Checking what you already know',
  ready: 'Ready to confirm',
  failed: 'Analysis stopped',
  withdrawn: 'Replaced by an edit',
};

/**
 * The phase for a capture, from its own status and the analysis run's current
 * stage. Stage names are the capture pipeline's: load, extract, resolve, propose.
 */
export function capturePhase(status: string, runStage: string | null | undefined): CapturePhase {
  if (status === 'proposed') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'replaced' || status === 'discarded') return 'withdrawn';
  if (status === 'received' && !runStage) return 'received';
  if (runStage === 'resolve' || runStage === 'propose') return 'matching';
  return 'analysing';
}
