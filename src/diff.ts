/**
 * Deterministic line diff for incremental remount (plan item 9). Compares two
 * fingerprint lists and returns, for each OLD line, the NEW line it maps to (or
 * undefined when it was deleted or changed). The mapping is monotonic, so mounted
 * segments remap by walking their surviving lines.
 */
import { normalizeLedger } from './mount-source.ts'
import type { LedgerSegment } from './types.ts'

/** Max cells in one LCS DP table; oversized slices without unique-line anchors stay unmatched. */
const MAX_MIDDLE_CELLS = 1_000_000

/**
 * Diff two fingerprint arrays. Returns an array of length oldFps.length where
 * index i (old line i+1) holds the matched NEW line number (1-based), or undefined
 * when no new line matches. Prefix and suffix lines match positionally; the middle
 * is matched by LCS. When the middle is too large for one DP table, unique
 * fingerprints (once in each side) split it into smaller LCS slices; a slice
 * still over the cell cap with no unique anchors is left unmatched.
 */
export function diffLines(oldFps: string[], newFps: string[]): (number | undefined)[] {
  const n = oldFps.length
  const m = newFps.length
  const oldToNew: (number | undefined)[] = new Array(n).fill(undefined)

  let p = 0
  while (p < n && p < m && oldFps[p] === newFps[p]) p++
  let s = 0
  while (s < n - p && s < m - p && oldFps[n - 1 - s] === newFps[m - 1 - s]) s++

  for (let i = 0; i < p; i++) oldToNew[i] = i + 1
  for (let i = 0; i < s; i++) oldToNew[n - 1 - i] = m - i

  const midOld = oldFps.slice(p, n - s)
  const midNew = newFps.slice(p, m - s)
  const matches = lcsMatches(midOld, midNew)
  for (let i = 0; i < midOld.length; i++) {
    const j = matches[i]
    if (j !== undefined && j !== -1) oldToNew[p + i] = p + j + 1
  }
  return oldToNew
}

/** Fingerprints that appear once on each side, walked in old order with increasing new index. */
function uniqueAnchors(a: string[], b: string[]): { i: number; j: number }[] {
  const countA = new Map<string, number>()
  const countB = new Map<string, number>()
  for (const fp of a) countA.set(fp, (countA.get(fp) ?? 0) + 1)
  for (const fp of b) countB.set(fp, (countB.get(fp) ?? 0) + 1)
  const posB = new Map<string, number>()
  for (let j = 0; j < b.length; j++) {
    const fp = b[j]!
    if (countA.get(fp) === 1 && countB.get(fp) === 1) posB.set(fp, j)
  }
  const anchors: { i: number; j: number }[] = []
  let lastJ = -1
  for (let i = 0; i < a.length; i++) {
    const j = posB.get(a[i]!)
    if (j !== undefined && j > lastJ) {
      anchors.push({ i, j })
      lastJ = j
    }
  }
  return anchors
}

/** Longest-common-subsequence match indices; oversized slices split on unique-line anchors. */
function lcsMatches(a: string[], b: string[]): number[] {
  const n = a.length
  const m = b.length
  const out = new Array(n).fill(-1)
  if (n === 0 || m === 0) return out
  if (n * m <= MAX_MIDDLE_CELLS) return lcsDp(a, b)

  const anchors = uniqueAnchors(a, b)
  if (anchors.length === 0) return out

  let prevI = -1
  let prevJ = -1
  const points = [...anchors, { i: n, j: m }]
  for (const { i, j } of points) {
    if (i < n) out[i] = j
    const subA = a.slice(prevI + 1, i)
    const subB = b.slice(prevJ + 1, j)
    if (subA.length > 0 && subB.length > 0) {
      const sub = lcsMatches(subA, subB)
      for (let k = 0; k < sub.length; k++) {
        if (sub[k] !== -1) out[prevI + 1 + k] = prevJ + 1 + sub[k]!
      }
    }
    prevI = i
    prevJ = j
  }
  return out
}

function lcsDp(a: string[], b: string[]): number[] {
  const n = a.length
  const m = b.length
  const out = new Array(n).fill(-1)
  const dp: number[][] = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out[i] = j
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return out
}

/**
 * Remap mounted segments (old coordinates) through a diff into new coordinates.
 * Surviving lines keep their ranges (contiguous survivors stay contiguous);
 * changed or deleted lines drop out. Adjacent surviving runs merge and carry
 * their freshness metadata through (earliest born, max expired) and a
 * line-count-proportional token estimate.
 */
export function remapSegments(segments: readonly LedgerSegment[], oldToNew: readonly (number | undefined)[]): LedgerSegment[] {
  const out: LedgerSegment[] = []
  for (const seg of segments) {
    let i = seg.start
    while (i <= seg.end) {
      const mapped = oldToNew[i - 1]
      if (mapped === undefined) {
        i++
        continue
      }
      let end = mapped
      let j = i + 1
      while (j <= seg.end && oldToNew[j - 1] === end + 1) {
        end = oldToNew[j - 1]!
        j++
      }
      const newLen = end - mapped + 1
      const oldLen = seg.end - seg.start + 1
      const tokens = seg.tokens !== undefined && oldLen > 0
        ? Math.round(seg.tokens * newLen / oldLen)
        : undefined
      out.push({
        start: mapped,
        end,
        ...seg.born !== undefined ? { born: seg.born } : {},
        ...seg.seq !== undefined ? { seq: seg.seq } : {},
        ...tokens !== undefined && tokens > 0 ? { tokens } : {},
        expired: seg.expired,
      })
      i = j
    }
  }
  return normalizeLedger(out)
}

/** Counts of added/removed/unchanged lines a diff implies (for the remount note). */
export function diffStats(oldToNew: readonly (number | undefined)[], newLineCount: number) {
  let removed = 0
  let unchanged = 0
  for (const mapped of oldToNew) {
    if (mapped === undefined) removed++
    else unchanged++
  }
  return { added: newLineCount - unchanged, removed, unchanged }
}