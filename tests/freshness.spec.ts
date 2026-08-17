/**
 * Freshness ledger rules (pressure × depth): normalizeLedger merge
 * semantics, calculateFreshnessScore, pruneExpired cutoff + pin, and
 * inheritHistory count carry-over.
 */
import { describe, expect, it } from 'vitest'
import {
  calculateFreshnessScore,
  inheritHistory,
  normalizeLedger,
  pruneExpired,
} from '../src/mount-source.ts'

const tightWindow = { contextWindow: 800, safeTokens: 100, pinAfter: 2 }

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
  it('keeps short contexts at score 1 (L <= Lsafe)', () => {
    expect(calculateFreshnessScore(50, 1_000)).toBe(1)
    expect(calculateFreshnessScore(500, 8_000)).toBe(1)
  })

  it('does not rise as L grows (monotonic non-increasing)', () => {
    const born = 100
    const opts = { contextWindow: 128_000, safeTokens: 16_000 }
    let previous = calculateFreshnessScore(born, 16_000, 0, opts)
    for (const L of [20_000, 40_000, 80_000, 128_000]) {
      const score = calculateFreshnessScore(born, L, 0, opts)
      expect(score).toBeLessThanOrEqual(previous + 1e-12)
      previous = score
    }
  })

  it('scores deeper (older) content lower than recent content at the same L', () => {
    const opts = { contextWindow: 128_000, safeTokens: 16_000 }
    const oldScore = calculateFreshnessScore(5_000, 40_000, 0, opts)
    const newScore = calculateFreshnessScore(35_000, 40_000, 0, opts)
    expect(oldScore).toBeLessThan(newScore)
  })

  it('pins at expired >= pinAfter', () => {
    const opts = { contextWindow: 800, safeTokens: 100, pinAfter: 2, expired: 2 }
    expect(calculateFreshnessScore(50, 700, 0, opts)).toBe(1)
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

  it('does not prune short contexts', () => {
    const r = pruneExpired([{ start: 1, end: 5, born: 100, expired: 0 }], 1_000)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('prunes deep content once the window fills past Lsafe', () => {
    const r = pruneExpired(
      [{ start: 1, end: 5, born: 50, expired: 0 }],
      700,
      0.6,
      tightWindow,
    )
    expect(r.active).toEqual([])
    expect(r.history).toEqual([{ start: 1, end: 5, expired: 1 }])
  })

  it('keeps recent (shallow) content at the same L', () => {
    const r = pruneExpired(
      [{ start: 1, end: 5, born: 680, expired: 0 }],
      700,
      0.6,
      tightWindow,
    )
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('does not prune a pinned segment (expired >= pinAfter)', () => {
    const r = pruneExpired(
      [{ start: 1, end: 5, born: 50, expired: 2 }],
      700,
      0.6,
      tightWindow,
    )
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
