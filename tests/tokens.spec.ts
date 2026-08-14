import { describe, expect, it } from 'vitest'
import { estimateRangeTokens, estimateTokens } from '../src/tokens.ts'

describe('estimateTokens', () => {
  it('uses the chars-div-4 rule', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('never estimates zero', () => {
    expect(estimateTokens('')).toBe(1)
  })
})

describe('estimateRangeTokens', () => {
  it('sums the lines inside the given ranges', () => {
    const lines = ['1234', '5678', '90', '12']
    expect(estimateRangeTokens(lines, 1, [{ start: 1, end: 2 }])).toBe(2)
  })

  it('respects the window offset', () => {
    const lines = ['a', 'b', 'c']
    expect(estimateRangeTokens(lines, 5, [{ start: 6, end: 6 }])).toBe(1)
    expect(estimateRangeTokens(lines, 5, [{ start: 1, end: 1 }])).toBe(0)
  })

  it('clamps ranges outside the window', () => {
    const lines = ['a', 'b']
    expect(estimateRangeTokens(lines, 1, [{ start: 1, end: 99 }])).toBe(2)
    expect(estimateRangeTokens(lines, 1, [{ start: 50, end: 99 }])).toBe(0)
  })

  it('sums multiple ranges', () => {
    const lines = ['a', 'b', 'c', 'd']
    expect(estimateRangeTokens(lines, 1, [{ start: 1, end: 1 }, { start: 4, end: 4 }])).toBe(2)
  })
})
