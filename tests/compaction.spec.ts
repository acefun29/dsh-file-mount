/**
 * Compaction awareness: checkpoint recognition and shadowed-seq collection.
 * The checkpoint shape is duck-typed from DSH's compaction marker (a
 * user/message whose source is { kind: 'compact-checkpoint' } since DSH 0.1.7,
 * { kind: 'plugin', plugin: 'compact' } before), so these tests build plain
 * event-shaped objects, not real session events.
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
  it('recognizes the v3 compact source on a user/message', () => {
    expect(isCompactCheckpoint(checkpoint())).toBe(true)
  })

  it('recognizes the DSH 0.1.7 compact-checkpoint source on a user/message', () => {
    expect(isCompactCheckpoint({
      type: 'user/message',
      seq: 4,
      data: { source: { kind: 'compact-checkpoint', compactionId: 'cmp-1' } },
      sourceEventSeqs: [1, 2],
    })).toBe(true)
    // A v3 log migrated to v4 carries the bare renamed kind.
    expect(isCompactCheckpoint({ type: 'user/message', data: { source: { kind: 'compact-checkpoint' } } })).toBe(true)
  })

  it('rejects compact-checkpoint on other event types and near-miss kinds', () => {
    expect(isCompactCheckpoint({ type: 'assistant/message', data: { source: { kind: 'compact-checkpoint' } } })).toBe(false)
    expect(isCompactCheckpoint({ type: 'user/message', data: { source: { kind: 'plugin:compact' } } })).toBe(false)
    expect(isCompactCheckpoint({ type: 'user/message', data: { source: { kind: 'compact-basic' } } })).toBe(false)
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

  it('collects the seqs shadowed by a DSH 0.1.7 checkpoint', () => {
    const seqs = shadowedSeqsOf([
      { type: 'user/message', seq: 1, data: { source: { kind: 'file-mount' } } },
      { type: 'user/message', seq: 5, data: { source: { kind: 'compact-checkpoint', compactionId: 'cmp-1' } }, sourceEventSeqs: [1, 2, 3] },
    ])
    expect([...seqs].sort((x, y) => x - y)).toEqual([1, 2, 3])
  })

  it('returns an empty set when no checkpoint exists', () => {
    expect(shadowedSeqsOf([]).size).toBe(0)
    expect(shadowedSeqsOf([
      { type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'file-mount' } } },
    ]).size).toBe(0)
  })
})
