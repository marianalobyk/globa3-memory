/**
 * Name normalisation and similarity, used by entity resolution.
 *
 * Implemented in TypeScript rather than with pg_trgm so the behaviour is
 * identical on Supabase and on a local test copy (pg_trgm/fuzzystrmatch are not
 * available in the local PGlite database), and so the scores can be shown to
 * the user in the Review screen.
 */

const DIACRITICS = /[̀-ͯ]/g;

/**
 * Legal-form suffixes only. Industry words such as "ventures", "media" or
 * "studios" are deliberately NOT treated as noise: they are exactly what
 * distinguishes "Serena Ventures" from "Serena Williams".
 */
const NOISE_TOKENS = new Set([
  'the', 'and', 'of', 'for', 'a', 'an',
  'inc', 'llc', 'ltd', 'limited', 'plc', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'bv', 'sa', 'sas', 'sarl', 'ag', 'ab', 'llp', 'lp', 'pte', 'pty',
  'fzco', 'fze', 'nv', 'oy', 'as',
]);

export function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(/[\u2019'`]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function slugify(input: string): string {
  const normalized = normalizeName(input).replace(/\s+/g, '-');
  return normalized.length > 0 ? normalized.slice(0, 120) : 'unnamed';
}

function tokens(input: string, dropNoise: boolean): string[] {
  const all = normalizeName(input).split(' ').filter(Boolean);
  if (!dropNoise) return all;
  const kept = all.filter((t) => !NOISE_TOKENS.has(t));
  return kept.length > 0 ? kept : all;
}

function bigrams(input: string): Set<string> {
  const s = normalizeName(input).replace(/ /g, '');
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** Sorensen-Dice coefficient over character bigrams. */
export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return normalizeName(a) === normalizeName(b) ? 1 : 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** Jaccard overlap over meaningful word tokens. */
export function tokenSimilarity(a: string, b: string): number {
  const A = new Set(tokens(a, true));
  const B = new Set(tokens(b, true));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * Pairwise token alignment: every token of the shorter name is matched to its
 * best counterpart in the longer name, and the total is divided by the LONGER
 * length so unmatched extra words dilute the score.
 *
 * This is what catches a misspelling ("Sara" / "Sarah") while refusing to treat
 * a shared first name as a company match ("Serena Ventures" / "Serena Williams").
 */
function tokenAlignment(a: string, b: string): number {
  const A = tokens(a, true);
  const B = tokens(b, true);
  if (A.length === 0 || B.length === 0) return 0;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  const used = new Set<number>();
  let total = 0;
  for (const token of short) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = 0; i < long.length; i += 1) {
      if (used.has(i)) continue;
      const candidate = long[i] as string;
      const score = token === candidate ? 1 : diceSimilarity(token, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    // Below this a "match" is coincidence, not a spelling variant.
    if (bestScore >= 0.5 && bestIndex >= 0) {
      used.add(bestIndex);
      total += bestScore;
    }
  }
  return total / long.length;
}

/**
 * A name that is the leading part of a longer one: "Sports One" inside
 * "Sports One Holdings". Worth surfacing as ambiguous, never as certain, and
 * the score falls as the unexplained remainder grows.
 */
function leadingSubsetScore(a: string, b: string): number {
  const A = tokens(a, true);
  const B = tokens(b, true);
  if (A.length === 0 || B.length === 0 || A.length === B.length) return 0;
  const [short, long] = A.length < B.length ? [A, B] : [B, A];
  for (let i = 0; i < short.length; i += 1) {
    if (short[i] !== long[i]) return 0;
  }
  return RESOLUTION_THRESHOLDS.ambiguous + 0.1 * (short.length / long.length);
}

/**
 * Combined 0..1 name similarity. Deliberately conservative in one direction
 * only: a high score marks a candidate for a human to look at, and never
 * authorises a merge. Surfacing an extra candidate is cheap; silently creating
 * a duplicate person is not.
 */
export function nameSimilarity(a: string, b: string): number {
  if (normalizeName(a) === normalizeName(b)) return 1;
  return Math.max(tokenAlignment(a, b), leadingSubsetScore(a, b));
}

/** An initialism such as "EIH" for "Emirates Investment Holding". */
export function isPlausibleAcronym(short: string, long: string): boolean {
  const s = normalizeName(short).replace(/ /g, '');
  if (s.length < 2 || s.length > 6) return false;
  // Every word counts here, including legal forms: "EIH" needs the H.
  const initials = tokens(long, false)
    .map((t) => t[0] ?? '')
    .join('');
  return initials.length >= 2 && initials === s;
}

export const RESOLUTION_THRESHOLDS = {
  /** At or above this, the match is shown to the user as an ambiguous candidate. */
  ambiguous: 0.72,
  /** At or above this, the candidate is ranked first but still needs a human. */
  strong: 0.86,
} as const;
