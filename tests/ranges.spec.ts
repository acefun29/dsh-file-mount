import { describe, expect, it } from 'vitest'
import { clamp, normalize, subtract } from '../src/ranges.ts'

describe('normalize', () => {
  it('returns an empty list for no input', () => {
    expect(normalize([])).toEqual([])
  })

  it('sorts unsorted input', () => {
    expect(normalize([{ start: 50, end: 60 }, { start: 1, end: 10 }])).toEqual([
      { start: 1, end: 10 },
      { start: 50, end: 60 },
    ])
  })

  it('merges overlapping ranges', () => {
    expect(normalize([{ start: 1, end: 10 }, { start: 5, end: 20 }])).toEqual([{ start: 1, end: 20 }])
  })

  it('merges adjacent ranges', () => {
    expect(normalize([{ start: 20, end: 40 }, { start: 41, end: 60 }])).toEqual([{ start: 20, end: 60 }])
  })

  it('merges a contained range without growth', () => {
    expect(normalize([{ start: 1, end: 100 }, { start: 40, end: 60 }])).toEqual([{ start: 1, end: 100 }])
  })

  it('keeps disjoint ranges separate', () => {
    expect(normalize([{ start: 1, end: 10 }, { start: 30, end: 40 }])).toEqual([
      { start: 1, end: 10 },
      { start: 30, end: 40 },
    ])
  })

  it('does not mutate its input', () => {
    const input = [{ start: 50, end: 60 }, { start: 1, end: 10 }]
    normalize(input)
    expect(input).toEqual([{ start: 50, end: 60 }, { start: 1, end: 10 }])
  })
})

describe('subtract', () => {
  it('returns nothing when have fully covers want', () => {
    expect(subtract([{ start: 1, end: 100 }], { start: 20, end: 80 })).toEqual([])
  })

  it('returns the whole want when nothing overlaps', () => {
    expect(subtract([{ start: 1, end: 10 }], { start: 50, end: 60 })).toEqual([{ start: 50, end: 60 }])
  })

  it('returns only the tail for a front overlap', () => {
    expect(subtract([{ start: 1, end: 100 }], { start: 50, end: 150 })).toEqual([{ start: 101, end: 150 }])
  })

  it('returns only the head for a back overlap', () => {
    expect(subtract([{ start: 50, end: 150 }], { start: 1, end: 100 })).toEqual([{ start: 1, end: 49 }])
  })

  it('splits around a covered middle', () => {
    expect(subtract([{ start: 50, end: 100 }], { start: 1, end: 150 })).toEqual([
      { start: 1, end: 49 },
      { start: 101, end: 150 },
    ])
  })

  it('merges adjacent have ranges before subtracting', () => {
    expect(subtract([{ start: 1, end: 10 }, { start: 11, end: 20 }], { start: 5, end: 25 })).toEqual([
      { start: 21, end: 25 },
    ])
  })

  it('handles multiple disjoint have ranges', () => {
    expect(
      subtract(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        { start: 5, end: 45 },
      ),
    ).toEqual([
      { start: 5, end: 9 },
      { start: 21, end: 29 },
      { start: 41, end: 45 },
    ])
  })
})

describe('clamp', () => {
  it('shrinks a range past the file end', () => {
    expect(clamp({ start: 80, end: 200 }, 100)).toEqual({ start: 80, end: 100 })
  })

  it('returns null when the range starts past the file', () => {
    expect(clamp({ start: 101, end: 120 }, 100)).toBeNull()
  })

  it('returns null for an empty file', () => {
    expect(clamp({ start: 1, end: 10 }, 0)).toBeNull()
  })

  it('returns the range unchanged when it fits', () => {
    expect(clamp({ start: 1, end: 50 }, 100)).toEqual({ start: 1, end: 50 })
  })
})
