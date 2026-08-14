import { describe, expect, it } from 'vitest'
import { diffLines, diffStats, remapSegments } from '../src/diff.ts'

describe('diffLines', () => {
  it('maps identical lines positionally', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([1, 2, 3])
  })

  it('keeps a matching prefix and suffix and leaves the changed middle unmatched', () => {
    const m = diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'X', 'd', 'e'])
    expect(m[0]).toBe(1)
    expect(m[1]).toBeUndefined()
    expect(m[2]).toBeUndefined()
    expect(m[3]).toBe(3)
    expect(m[4]).toBe(4)
  })

  it('shifts survivors after a pure head insertion', () => {
    expect(diffLines(['a', 'b', 'c'], ['X', 'Y', 'a', 'b', 'c'])).toEqual([3, 4, 5])
  })

  it('drops a deleted middle line', () => {
    const m = diffLines(['a', 'b', 'c'], ['a', 'c'])
    expect(m[0]).toBe(1)
    expect(m[1]).toBeUndefined()
    expect(m[2]).toBe(2)
  })

  it('returns all undefined when nothing matches', () => {
    expect(diffLines(['a', 'b'], ['x', 'y', 'z'])).toEqual([undefined, undefined])
  })

  it('is deterministic for duplicate lines', () => {
    const a = ['x', 'x', 'y']
    const b = ['x', 'y']
    expect(diffLines(a, b)).toEqual(diffLines(a, b))
  })
})

describe('remapSegments', () => {
  it('shifts a fully-surviving segment', () => {
    // old lines 4,5,6 -> new lines 1,2,3
    const segs = remapSegments([{ start: 4, end: 6 }], [undefined, undefined, undefined, 1, 2, 3])
    expect(segs).toEqual([{ start: 1, end: 3 }])
  })

  it('splits around an inserted line', () => {
    // old 1,2,3 -> new: 1->1, 2->3, 3->4 (new line 2 inserted)
    const segs = remapSegments([{ start: 1, end: 3 }], [1, 3, 4])
    expect(segs).toEqual([{ start: 1, end: 1 }, { start: 3, end: 4 }])
  })

  it('returns empty when nothing survives', () => {
    const segs = remapSegments([{ start: 1, end: 3 }], [undefined, undefined, undefined])
    expect(segs).toEqual([])
  })

  it('merges adjacent surviving runs across segments', () => {
    const segs = remapSegments([{ start: 1, end: 2 }, { start: 4, end: 5 }], [1, 2, undefined, 3, 4])
    expect(segs).toEqual([{ start: 1, end: 4 }])
  })
})

describe('diffStats', () => {
  it('counts added, removed, and unchanged lines', () => {
    const m = [1, undefined, 4]
    expect(diffStats(m, 4)).toEqual({ added: 2, removed: 1, unchanged: 2 })
  })

  it('reports all-new and all-removed', () => {
    expect(diffStats([undefined, undefined], 0)).toEqual({ added: 0, removed: 2, unchanged: 0 })
    expect(diffStats([], 3)).toEqual({ added: 3, removed: 0, unchanged: 0 })
  })
})
