/**
 * Coarse token estimates for saved-context accounting. CJK characters count
 * as one token each (a Han character is roughly one token); everything else
 * uses the ÷4 rule. A precise tokenizer is deferred.
 */

/** One code point that counts as a full token (CJK + fullwidth + Hangul + kana). */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/

/**
 * Estimate the token count of a model-facing text: CJK characters count as
 * one token each, the remaining characters as chars ÷ 4 (min 1 overall).
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk++
    else other++
  }
  return Math.max(1, cjk + Math.ceil(other / 4))
}

/**
 * Estimate the token count of the given window lines lying inside
 * `ranges` (1-based, in-window). Range bounds outside the window are
 * clamped so foreign ranges never read past the array.
 */
export function estimateRangeTokens(lines: readonly string[], windowStart: number, ranges: readonly { start: number; end: number }[]): number {
  let total = 0
  for (const range of ranges) {
    const first = Math.max(0, range.start - windowStart)
    const last = Math.min(lines.length - 1, range.end - windowStart)
    for (let i = first; i <= last; i++) {
      total += estimateTokens(lines[i] ?? '')
    }
  }
  return total
}
