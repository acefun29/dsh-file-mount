/**
 * Freshness ledger rules (U-shaped attention decay model): normalizeLedger
 * merge semantics, calculateFreshnessScore U-curve math, pruneExpired U-score
 * cutoff, and inheritHistory count carry-over.
 */
import { describe, expect, it } from 'vitest'
import {
  calculateFreshnessScore,
  inheritHistory,
  normalizeLedger,
  pruneExpired,
} from '../src/mount-source.ts'

describe('normalizeLedger', () => {
  it('merges adjacent segments ONLY when born is identical, summing tokens and taking max expired', () => {
    const out = normalizeLedger([
      { start: 1, end: 10, born: 500, tokens: 20, expired: 2 },
      { start: 11, end: 20, born: 500, tokens: 30, expired: 5 },
    ])
    expect(out).toEqual([{ start: 1, end: 20, born: 500, tokens: 50, expired: 5 }])
  })

  it('does NOT merge adjacent segments when born values differ', () => {
    const out = normalizeLedger([
      { start: 1, end: 10, born: 500, tokens: 20, expired: 2 },
      { start: 11, end: 20, born: 900, tokens: 30, expired: 5 },
    ])
    expect(out).toEqual([
      { start: 1, end: 10, born: 500, tokens: 20, expired: 2 },
      { start: 11, end: 20, born: 900, tokens: 30, expired: 5 },
    ])
  })

  it('merges adjacent segments when both born values are undefined', () => {
    const out = normalizeLedger([
      { start: 1, end: 10, expired: 0 },
      { start: 11, end: 20, expired: 1 },
    ])
    expect(out).toEqual([{ start: 1, end: 20, expired: 1 }])
  })

  it('does NOT merge adjacent segments when one has born and the other does not', () => {
    const out = normalizeLedger([
      { start: 1, end: 10, expired: 0 },
      { start: 11, end: 20, born: 500, expired: 1 },
    ])
    expect(out).toEqual([
      { start: 1, end: 10, expired: 0 },
      { start: 11, end: 20, born: 500, expired: 1 },
    ])
  })

  it('merges overlapping segments: newer born wins, tokens updated, max expired kept', () => {
    const out = normalizeLedger([
      { start: 1, end: 15, born: 100, tokens: 30, expired: 1 },
      { start: 10, end: 25, born: 300, tokens: 40, expired: 3 },
    ])
    expect(out).toEqual([{ start: 1, end: 25, born: 300, tokens: 40, expired: 3 }])
  })
})

describe('calculateFreshnessScore', () => {
  it('returns high score near head (p -> 0) and tail (p -> 1)', () => {
    // Tail: born = 950, L = 1000 -> p ≈ 0.95 -> Score > 0.85
    const tailScore = calculateFreshnessScore(950, 1000)
    expect(tailScore).toBeGreaterThan(0.85)

    // Head: born = 50, L = 1000 -> p ≈ 0.05 -> Score > 0.85
    const headScore = calculateFreshnessScore(50, 1000)
    expect(headScore).toBeGreaterThan(0.85)
  })

  it('hits valley score at midpoint p = 0.5 (Score = 1 - lambda = 0.3 for S = 0)', () => {
    const midScore = calculateFreshnessScore(500, 1000)
    expect(midScore).toBeCloseTo(0.3, 5)
  })

  it('boosts score with volume protection when tokens S > 0', () => {
    // S = 100, L = 1000 -> eta = 0.1, W = 1 + min(0.5 * sqrt(0.1), 0.5) ≈ 1 + 0.158 = 1.158
    const scoreWithTokens = calculateFreshnessScore(550, 1000, 100)
    const scoreWithoutTokens = calculateFreshnessScore(550, 1000, 0)
    expect(scoreWithTokens).toBeGreaterThan(scoreWithoutTokens)
  })

  it('ensures giant segments (eta >= 0.444) never drop below 0.40 at valley', () => {
    // Single segment occupying 45% of context (S = 450, L = 1000)
    // Center of segment at midpoint (born = 725, S = 450 -> p1 = 0.275, p2 = 0.725, pm = 0.5)
    const giantScore = calculateFreshnessScore(725, 1000, 450)
    expect(giantScore).toBeGreaterThanOrEqual(0.40)
  })
})

describe('pruneExpired', () => {
  it('keeps everything when the context length is unknown or < 1', () => {
    const r1 = pruneExpired([{ start: 1, end: 5, born: 10, expired: 0 }], undefined)
    expect(r1.active).toHaveLength(1)
    expect(r1.history).toEqual([])

    const r2 = pruneExpired([{ start: 1, end: 5, born: 10, expired: 0 }], 0)
    expect(r2.active).toHaveLength(1)
    expect(r2.history).toEqual([])
  })

  it('keeps segments without born (unknown freshness never prunes)', () => {
    const r = pruneExpired([{ start: 1, end: 5, expired: 0 }], 1000)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('keeps impossibly fresh segments where born >= contextL', () => {
    const r = pruneExpired([{ start: 1, end: 5, born: 1200, expired: 0 }], 1000)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('prunes mid-window segments where U-score < 0.4', () => {
    // born 500, L 1000 -> p = 0.5, score = 0.3 < 0.4 -> expired
    const r = pruneExpired([{ start: 1, end: 5, born: 500, expired: 3 }], 1000)
    expect(r.active).toEqual([])
    expect(r.history).toEqual([{ start: 1, end: 5, expired: 4 }])
  })

  it('keeps head segments (head zone immortality: Score > 0.4 when L > 3.23 * born)', () => {
    // born 100, L 1000 -> p = 0.1, Score ≈ 1 - 4 * 0.7 * 0.1 * 0.9 = 1 - 0.252 = 0.748 >= 0.4
    const r = pruneExpired([{ start: 1, end: 5, born: 100, expired: 0 }], 1000)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('keeps tail segments (tail zone: Score > 0.4 when born ≈ L)', () => {
    // born 950, L 1000 -> p = 0.95, Score ≈ 0.867 >= 0.4
    const r = pruneExpired([{ start: 1, end: 5, born: 950, expired: 0 }], 1000)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('honors custom threshold and lambda configuration', () => {
    // born 500, L 1000 -> score = 0.3
    // With threshold = 0.2, score 0.3 >= 0.2 -> kept
    const r = pruneExpired([{ start: 1, end: 5, born: 500, expired: 0 }], 1000, 0.2)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })
})

describe('inheritHistory', () => {
  it('stamps the max overlapping expired count and drops consumed history', () => {
    const r = inheritHistory(
      [{ start: 10, end: 20, tokens: 50, expired: 0 }],
      [
        { start: 1, end: 15, expired: 1 },
        { start: 30, end: 40, expired: 7 },
      ],
    )
    expect(r.segments).toEqual([{ start: 10, end: 20, tokens: 50, expired: 1 }])
    expect(r.history).toEqual([{ start: 30, end: 40, expired: 7 }])
  })

  it('keeps existing expired counts on re-mounts (max wins)', () => {
    const r = inheritHistory(
      [{ start: 10, end: 20, tokens: 30, expired: 2 }],
      [{ start: 5, end: 25, expired: 5 }],
    )
    expect(r.segments).toEqual([{ start: 10, end: 20, tokens: 30, expired: 5 }])
  })
})
