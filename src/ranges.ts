/**
 * Line-range set arithmetic for the mount ledger (ported from piwpi's
 * context-mount ranges.ts). Pure functions over 1-based inclusive intervals;
 * every returned array is a fresh, normalized (sorted, merged, non-adjacent)
 * range list. The ledger calls these to answer "which part of this read is
 * NOT already in the model context".
 */

export type LineRange = { start: number; end: number }

/** Sort and merge overlapping or touching ranges ([20,40]+[41,60] -> [20,60]). */
export function normalize(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: LineRange[] = []
  let cur: LineRange = { ...sorted[0]! }
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!
    if (r.start <= cur.end + 1) {
      cur.end = Math.max(cur.end, r.end)
    } else {
      out.push(cur)
      cur = { ...r }
    }
  }
  out.push(cur)
  return out
}

/**
 * Parts of `want` not covered by `have` (ascending, non-adjacent). `have` is
 * normalized first so overlapping or touching mounted ranges merge correctly.
 */
export function subtract(have: LineRange[], want: LineRange): LineRange[] {
  const normalized = normalize(have)
  const missing: LineRange[] = []
  let cursor = want.start
  for (const r of normalized) {
    if (r.end < want.start) continue
    if (r.start > want.end) break
    if (r.start > cursor) {
      missing.push({ start: cursor, end: Math.min(r.start - 1, want.end) })
    }
    cursor = Math.max(cursor, r.end + 1)
    if (cursor > want.end) break
  }
  if (cursor <= want.end) {
    missing.push({ start: cursor, end: want.end })
  }
  return missing
}

/**
 * Truncate a range to a file that shrank to maxEnd lines. Returns null when
 * the range lies entirely past the file (or the file is empty).
 */
export function clamp(r: LineRange, maxEnd: number): LineRange | null {
  if (maxEnd < 1 || r.start > maxEnd) return null
  return { start: r.start, end: Math.min(r.end, maxEnd) }
}
