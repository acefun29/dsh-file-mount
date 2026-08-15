/**
 * Freshness ledger rules (attention-decay plan): normalizeLedger merge
 * semantics, pruneExpired drift cut-off, and inheritHistory count carry-over.
 */
import { describe, expect, it } from 'vitest'
import { inheritHistory, normalizeLedger, pruneExpired } from '../src/mount-source.ts'

describe('normalizeLedger', () => {
  it('merges adjacent segments keeping the earliest born and max expired', () => {
    const out = normalizeLedger([
      { start: 1, end: 10, born: 500, expired: 2 },
      { start: 11, end: 20, born: 900, expired: 5 },
    ])
    expect(out).toEqual([{ start: 1, end: 20, born: 500, expired: 5 }])
  })

  it('keeps a segment without born alongside one with born', () => {
    const out = normalizeLedger([
      { start: 1, end: 5, expired: 0 },
      { start: 10, end: 15, born: 100, expired: 1 },
    ])
    expect(out).toEqual([
      { start: 1, end: 5, expired: 0 },
      { start: 10, end: 15, born: 100, expired: 1 },
    ])
  })
})

describe('pruneExpired', () => {
  it('keeps everything when the context length is unknown', () => {
    const r = pruneExpired([{ start: 1, end: 5, born: 10, expired: 0 }], undefined, 0.85)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('keeps segments without born (unknown freshness never prunes)', () => {
    const r = pruneExpired([{ start: 1, end: 5, expired: 0 }], 1000, 0.85)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('moves a segment past the threshold to history with count+1', () => {
    // born 10, L 100 -> drift 0.9 > 0.85 -> expired.
    const r = pruneExpired([{ start: 1, end: 5, born: 10, expired: 3 }], 100, 0.85)
    expect(r.active).toEqual([])
    expect(r.history).toEqual([{ start: 1, end: 5, expired: 4 }])
  })

  it('keeps a fresh segment near the tail', () => {
    // born 90, L 100 -> drift 0.1 <= 0.15 fresh.
    const r = pruneExpired([{ start: 1, end: 5, born: 90, expired: 0 }], 100, 0.85)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })

  it('threshold >= 1 disables pruning entirely', () => {
    const r = pruneExpired([{ start: 1, end: 5, born: 1, expired: 0 }], 1000, 1)
    expect(r.active).toHaveLength(1)
    expect(r.history).toEqual([])
  })
})

describe('inheritHistory', () => {
  it('stamps the max overlapping expired count and drops consumed history', () => {
    const r = inheritHistory(
      [{ start: 10, end: 20, expired: 0 }],
      [
        { start: 1, end: 15, expired: 1 },
        { start: 30, end: 40, expired: 7 },
      ],
    )
    expect(r.segments).toEqual([{ start: 10, end: 20, expired: 1 }])
    expect(r.history).toEqual([{ start: 30, end: 40, expired: 7 }])
  })

  it('keeps existing expired counts on re-mounts (max wins)', () => {
    const r = inheritHistory(
      [{ start: 10, end: 20, expired: 2 }],
      [{ start: 5, end: 25, expired: 5 }],
    )
    expect(r.segments).toEqual([{ start: 10, end: 20, expired: 5 }])
  })
})
