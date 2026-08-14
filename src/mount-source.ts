/**
 * The ONE ledger rule shared by the host half (MountStore.replay) and the
 * browser half (foldMounts): source validation + the same-hash-unions /
 * hash-change-replaces merge. Editing the fold semantics here edits both
 * halves at once (plan item 20).
 */
import { normalize } from './ranges.ts'
import type { MountKind, Segment } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidSegment(value: unknown): value is Segment {
  if (!isRecord(value)) return false
  const { start, end } = value
  return typeof start === 'number' && typeof end === 'number'
    && Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= 1 && end >= start
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Saturating addition: the token counters never overflow the safe-int range. */
function saturatingAdd(a: number, b: number): number {
  const sum = a + b
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum
}

/** What one mount message adds to the ledger (post-validation). */
export interface MountDelta {
  hash: string
  totalLines: number
  segments: Segment[]
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
 * breaks the ledger.
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
    || !mounted.every(isValidSegment)) return undefined
  return {
    path,
    mountKind,
    delta: {
      hash,
      totalLines,
      segments: normalize(mounted),
      savedTokens: nonNegative(savedTokens),
      spentTokens: nonNegative(spentTokens),
    },
  }
}

/** Fold state shared by the host ledger and the browser view. */
export interface MountState {
  hash: string
  totalLines: number
  segments: Segment[]
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
      segments: normalize([...existing.segments, ...delta.segments]),
      savedTokens: saturatingAdd(existing.savedTokens, delta.savedTokens),
      spentTokens: saturatingAdd(existing.spentTokens, delta.spentTokens),
    }
  }
  return {
    hash: delta.hash,
    totalLines: delta.totalLines,
    segments: normalize(delta.segments),
    savedTokens: saturatingAdd(existing?.savedTokens ?? 0, delta.savedTokens),
    spentTokens: saturatingAdd(existing?.spentTokens ?? 0, delta.spentTokens),
  }
}
