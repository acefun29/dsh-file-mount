/**
 * Compaction awareness: checkpoint recognition and shadowed-seq collection.
 * The checkpoint shape is duck-typed from DSH's canonical compaction marker
 * (user/message with source { kind: 'plugin', plugin: 'compact' }), so these
 * tests build plain event-shaped objects, not real session events.
 */
import { describe, expect, it } from 'vitest'
import { isCompactCheckpoint, shadowedSeqsOf } from '../src/compaction.ts'

function checkpoint(sourceEventSeqs?: unknown): Record<string, unknown> {
  return {
    type: 'user/message',
    seq: 0,
    data: { source: { kind: 'plugin', plugin: 'compact' } },
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
  }
}

describe('isCompactCheckpoint', () => {
  it('recognizes the canonical compact source on a user/message', () => {
    expect(isCompactCheckpoint(checkpoint())).toBe(true)
  })

  it('rejects foreign sources, other types, and malformed shapes', () => {
    expect(isCompactCheckpoint({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'file-mount' } } })).toBe(false)
    expect(isCompactCheckpoint({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(false)
    expect(isCompactCheckpoint({ type: 'assistant/message', data: { source: { kind: 'plugin', plugin: 'compact' } } })).toBe(false)
    expect(isCompactCheckpoint(null)).toBe(false)
    expect(isCompactCheckpoint('user/message')).toBe(false)
    expect(isCompactCheckpoint({ type: 'user/message' })).toBe(false)
  })
})

describe('shadowedSeqsOf', () => {
  it('collects the seqs of every checkpoint (union across checkpoints)', () => {
    const seqs = shadowedSeqsOf([
      checkpoint([1, 2, 3]),
      { type: 'user/message', seq: 9, data: { source: { kind: 'user' } } },
      checkpoint([3, 5]),
    ])
    expect([...seqs].sort((x, y) => x - y)).toEqual([1, 2, 3, 5])
  })

  it('skips non-integer entries and malformed lists defensively', () => {
    const seqs = shadowedSeqsOf([
      checkpoint([0, 2.5, -1, 4, '7', null]),
      checkpoint('not-a-list'),
      checkpoint(undefined),
    ])
    expect([...seqs].sort((x, y) => x - y)).toEqual([0, 4])
  })

  it('returns an empty set when no checkpoint exists', () => {
    expect(shadowedSeqsOf([]).size).toBe(0)
    expect(shadowedSeqsOf([
      { type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'file-mount' } } },
    ]).size).toBe(0)
  })
})
