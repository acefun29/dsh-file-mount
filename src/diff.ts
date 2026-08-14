/**
 * Deterministic line diff for incremental remount (plan item 9). Compares two
 * fingerprint lists and returns, for each OLD line, the NEW line it maps to (or
 * undefined when it was deleted or changed). The mapping is monotonic, so mounted
 * segments remap by walking their surviving lines.
 */
import { normalize, type LineRange } from './ranges.ts'

/** Max cells in the middle LCS DP table; oversized middles stay unmatched. */
const MAX_MIDDLE_CELLS = 1_000_000

/**
 * Diff two fingerprint arrays. Returns an array of length oldFps.length where
 * index i (old line i+1) holds the matched NEW line number (1-based), or undefined
 * when no new line matches. Prefix and suffix lines match positionally; the middle
 * is matched by a longest-common-subsequence dynamic program with a size cap (an
 * oversized middle is left unmatched rather than risk a misalignment).
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

/** Longest-common-subsequence match indices for a middle slice (or none if capped). */
function lcsMatches(a: string[], b: string[]): number[] {
  const n = a.length
  const m = b.length
  const out = new Array(n).fill(-1)
  if (n === 0 || m === 0 || n * m > MAX_MIDDLE_CELLS) return out
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
 * changed or deleted lines drop out. Adjacent surviving runs merge.
 */
export function remapSegments(segments: readonly LineRange[], oldToNew: readonly (number | undefined)[]): LineRange[] {
  const out: LineRange[] = []
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
      out.push({ start: mapped, end })
      i = j
    }
  }
  return normalize(out)
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
