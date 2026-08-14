/**
 * Coarse token estimates for saved-context accounting. The ÷4 rule is the
 * documented v1 approximation (see the plan doc, section 7); a precise
 * tokenizer is deferred.
 */

/** Estimate the token count of a model-facing text (chars ÷ 4, min 1). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
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
