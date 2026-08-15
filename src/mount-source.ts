/**
 * The ONE ledger rule shared by the host half (MountStore.replay) and the
 * browser half (foldMounts): source validation + the same-hash-unions /
 * hash-change-replaces merge. Editing the fold semantics here edits both
 * halves at once (plan item 20).
 *
 * Freshness (attention-decay plan): each segment carries `born` (context
 * position in input tokens at mount time) and `expired` (how many times the
 * content expired and was re-read). The merge rules are: same hash unions
 * segments (adjacent merge keeps the EARLIEST born and the MAX expired), a
 * hash change replaces the entry wholesale; expired segments are pruned off
 * the ledger by the host (they stop deduping) and their count moves into the
 * per-file history so a re-mount inherits it.
 */
import type { ExpiredSegment, LedgerSegment, MountKind } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate one mounted ledger segment: geometry required, meta optional. */
function isValidLedgerSegment(value: unknown): value is LedgerSegment {
  if (!isRecord(value)) return false
  const { start, end, born, tokens, expired } = value
  if (typeof start !== 'number' || typeof end !== 'number'
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start) return false
  if (born !== undefined && (typeof born !== 'number' || !Number.isSafeInteger(born) || born < 0)) return false
  if (tokens !== undefined && (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0)) return false
  if (expired !== undefined && (typeof expired !== 'number' || !Number.isSafeInteger(expired) || expired < 0)) return false
  return true
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Saturating addition: the token counters never overflow the safe-int range. */
function saturatingAdd(a: number, b: number): number {
  const sum = a + b
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum
}

/**
 * Normalize ledger segments: sort ascending, merge overlapping ranges (newer
 * mount's born wins). Adjacent ranges merge ONLY when their born values are
 * identical (or both unknown) so a newly refreshed born is not swallowed by
 * an older neighbor.
 */
export function normalizeLedger(segments: readonly LedgerSegment[]): LedgerSegment[] {
  if (segments.length === 0) return []
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: LedgerSegment[] = []
  let cur: LedgerSegment = { ...sorted[0]! }
  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i]!
    if (seg.start <= cur.end) {
      // OVERLAP: the same content was mounted again — the newer mount's
      // freshness is the current truth (its born wins), the expired count
      // never goes backwards.
      cur.end = Math.max(cur.end, seg.end)
      if (seg.born !== undefined) cur.born = seg.born
      if (seg.tokens !== undefined) cur.tokens = seg.tokens
      if (seg.expired > cur.expired) cur.expired = seg.expired
    } else if (
      seg.start === cur.end + 1
      && ((cur.born === undefined && seg.born === undefined) || (cur.born !== undefined && seg.born !== undefined && cur.born === seg.born))
    ) {
      // ADJACENT: merge only when born is identical or both unknown (Section 5/8).
      cur.end = seg.end
      if (cur.tokens !== undefined || seg.tokens !== undefined) {
        cur.tokens = (cur.tokens ?? 0) + (seg.tokens ?? 0)
      }
      if (seg.expired > cur.expired) cur.expired = seg.expired
    } else {
      out.push(cur)
      cur = { ...seg }
    }
  }
  out.push(cur)
  return out
}

/** What one mount message adds to the ledger (post-validation). */
export interface MountDelta {
  hash: string
  totalLines: number
  segments: LedgerSegment[]
  savedTokens: number
  spentTokens: number
}

/** A validated file-mount source: the identity plus the delta it carries. */
export interface ParsedMountSource {
  path: string
  mountKind: MountKind
  delta: MountDelta
}

/**
 * Validate a file-mount source (the injected message's structured source).
 * Returns undefined for foreign or malformed shapes, so a foreign log never
 * breaks the ledger. Segments without freshness fields (pre-freshness
 * messages) fold with born undefined and expired 0.
 */
export function parseMountSource(source: unknown): ParsedMountSource | undefined {
  if (!isRecord(source)) return undefined
  if (source['kind'] !== 'plugin' || source['plugin'] !== 'file-mount') return undefined
  const { path, hash, totalLines, mounted, mountKind, savedTokens, spentTokens } = source
  if (typeof path !== 'string' || path.length === 0
    || typeof hash !== 'string' || hash.length === 0
    || typeof totalLines !== 'number' || !Number.isSafeInteger(totalLines) || totalLines < 1
    || (mountKind !== 'new' && mountKind !== 'increment' && mountKind !== 'remount' && mountKind !== 'dedup')
    || !Array.isArray(mounted) || mounted.length === 0
    || !mounted.every(isValidLedgerSegment)) return undefined
  return {
    path,
    mountKind,
    delta: {
      hash,
      totalLines,
      segments: normalizeLedger(mounted.map((seg) => ({
        start: seg.start,
        end: seg.end,
        ...seg.born !== undefined ? { born: seg.born } : {},
        ...seg.tokens !== undefined ? { tokens: seg.tokens } : {},
        expired: seg.expired ?? 0,
      }))),
      savedTokens: nonNegative(savedTokens),
      spentTokens: nonNegative(spentTokens),
    },
  }
}

/** Fold state shared by the host ledger and the browser view. */
export interface MountState {
  hash: string
  totalLines: number
  segments: LedgerSegment[]
  savedTokens: number
  spentTokens: number
}

/**
 * The fold rule: same hash unions segments and accumulates tokens; a hash
 * change replaces the entry wholesale (the old mount is stale) while the
 * cumulative totals survive.
 */
export function applyMountState(existing: MountState | undefined, delta: MountDelta): MountState {
  if (existing !== undefined && existing.hash === delta.hash) {
    return {
      hash: existing.hash,
      totalLines: delta.totalLines,
      segments: normalizeLedger([...existing.segments, ...delta.segments]),
      savedTokens: saturatingAdd(existing.savedTokens, delta.savedTokens),
      spentTokens: saturatingAdd(existing.spentTokens, delta.spentTokens),
    }
  }
  return {
    hash: delta.hash,
    totalLines: delta.totalLines,
    segments: normalizeLedger(delta.segments),
    savedTokens: saturatingAdd(existing?.savedTokens ?? 0, delta.savedTokens),
    spentTokens: saturatingAdd(existing?.spentTokens ?? 0, delta.spentTokens),
  }
}

/** Result of pruning expired segments off the ledger. */
export interface PruneResult {
  /** Segments that are still fresh (kept on the ledger). */
  active: LedgerSegment[]
  /** The expired ones with their count bumped (moved to per-file history). */
  history: ExpiredSegment[]
}

export interface FreshnessOptions {
  lambda?: number
  alpha?: number
  Wmax?: number
}

export const DEFAULT_FRESHNESS_CONFIG = {
  threshold: 0.4,
  lambda: 0.7,
  alpha: 0.5,
  Wmax: 0.5,
  valveReads: 2,
} as const

/**
 * Calculate the U-shaped attention freshness score for one ledger segment.
 * Score = A_bar * W
 * A(p) = 1 - 4 * lambda * p * (1 - p)
 * A_bar = (A(p1) + 4 * A(pm) + A(p2)) / 6 (Simpson's exact integral)
 * W = 1 + min(alpha * sqrt(eta), Wmax) where eta = min(1, S / L)
 */
export function calculateFreshnessScore(
  born: number,
  contextL: number,
  tokens?: number,
  options?: FreshnessOptions,
): number {
  if (contextL < 1) return 1
  const lambda = options?.lambda ?? DEFAULT_FRESHNESS_CONFIG.lambda
  const alpha = options?.alpha ?? DEFAULT_FRESHNESS_CONFIG.alpha
  const Wmax = options?.Wmax ?? DEFAULT_FRESHNESS_CONFIG.Wmax

  const S = (tokens !== undefined && tokens > 0) ? tokens : 0
  const p1 = Math.max(0, (born - S) / contextL)
  const p2 = Math.min(1, born / contextL)
  const pm = (p1 + p2) / 2

  const A = (p: number) => 1 - 4 * lambda * p * (1 - p)
  const A_bar = (A(p1) + 4 * A(pm) + A(p2)) / 6

  const eta = Math.min(1, S / contextL)
  const W = 1 + Math.min(alpha * Math.sqrt(eta), Wmax)

  return A_bar * W
}

/**
 * Lazy freshness check (U-score attention model): a segment is expired when
 * its U-score dips below threshold (Score < freshnessThreshold).
 * Expired segments leave the ledger (they stop deduping; the next read re-sends
 * them) and their expired count moves into the history. Segments without a born
 * (no usage data yet, or pre-freshness messages) or with born >= contextL are never pruned.
 */
export function pruneExpired(
  segments: readonly LedgerSegment[],
  contextL: number | undefined,
  threshold: number = DEFAULT_FRESHNESS_CONFIG.threshold,
  options?: FreshnessOptions,
): PruneResult {
  if (contextL === undefined || contextL < 1) {
    return { active: [...segments], history: [] }
  }
  const active: LedgerSegment[] = []
  const history: ExpiredSegment[] = []
  for (const seg of segments) {
    if (seg.born === undefined || seg.born >= contextL) {
      // Unknown or impossibly-fresh position: keep (grey/unknown, never prune).
      active.push(seg)
      continue
    }
    const score = calculateFreshnessScore(seg.born, contextL, seg.tokens, options)
    if (score < threshold) history.push({ start: seg.start, end: seg.end, expired: seg.expired + 1 })
    else active.push(seg)
  }
  return { active, history }
}

/**
 * Let freshly mounted segments inherit the expired count of overlapping
 * history entries (the content was re-read after expiring), then drop those
 * history entries (the range is fresh again). Overlaps are counted once per
 * history item (max across all overlapping items wins for every new segment).
 */
export function inheritHistory(
  segments: readonly LedgerSegment[],
  history: readonly ExpiredSegment[],
): { segments: LedgerSegment[]; history: ExpiredSegment[] } {
  if (history.length === 0) return { segments: [...segments], history: [] }
  const kept: ExpiredSegment[] = []
  const consumed: ExpiredSegment[] = []
  for (const item of history) {
    const overlaps = segments.some((seg) => item.start <= seg.end && item.end >= seg.start)
    if (overlaps) consumed.push(item)
    else kept.push(item)
  }
  const maxExpired = consumed.reduce((m, item) => Math.max(m, item.expired), 0)
  if (maxExpired === 0) return { segments: [...segments], history: kept }
  return {
    // The count never goes backwards: an already-counted segment keeps the max.
    segments: segments.map((seg) => ({ ...seg, expired: Math.max(seg.expired, maxExpired) })),
    history: kept,
  }
}
