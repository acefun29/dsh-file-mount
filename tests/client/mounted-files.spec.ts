import { describe, expect, it } from 'vitest'
import type { ConversationNode, ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { foldMounts, freshnessLevel } from '../../src/client/mounted-files.ts'

function contextNode(source: Record<string, unknown>, seq = 1, time = 1000): ContextMessageNode {
  return {
    kind: 'context',
    seq,
    time,
    content: [{ type: 'text', text: 'block' }],
    source,
    provenance: { role: 'inject', label: 'file-mount' },
    form: null,
  }
}

function mountSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'plugin',
    plugin: 'file-mount',
    form: 'notice',
    summary: 'mounted L1-50',
    path: 'src/a.ts',
    hash: 'h1',
    totalLines: 100,
    mounted: [{ start: 1, end: 50 }],
    added: [{ start: 1, end: 50 }],
    mountKind: 'new',
    savedTokens: 0,
    ...overrides,
  }
}

describe('foldMounts', () => {
  it('returns an empty list for no mount messages', () => {
    expect(foldMounts([])).toEqual([])
  })

  it('folds one new mount', () => {
    const mounts = foldMounts([contextNode(mountSource())])
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({
      path: 'src/a.ts',
      hash: 'h1',
      totalLines: 100,
      ranges: [{ start: 1, end: 50 }],
      mountKind: 'new',
      savedTokens: 0,
    })
  })

  it('unions same-hash increments and keeps the latest kind', () => {
    const mounts = foldMounts([
      contextNode(mountSource(), 1),
      contextNode(mountSource({ mounted: [{ start: 1, end: 80 }], added: [{ start: 51, end: 80 }], mountKind: 'increment' }), 2),
    ])
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.ranges).toEqual([{ start: 1, end: 80, expired: 0 }])
    expect(mounts[0]!.mountKind).toBe('increment')
    expect(mounts[0]!.seq).toBe(2)
    expect(mounts[0]!.savedTokens).toBe(0)
  })

  it('replaces the entry wholesale on a hash change', () => {
    const mounts = foldMounts([
      contextNode(mountSource(), 1),
      contextNode(mountSource({ hash: 'h2', totalLines: 120, mounted: [{ start: 1, end: 20 }], added: [{ start: 1, end: 20 }], mountKind: 'remount', savedTokens: 9 }), 2),
    ])
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.hash).toBe('h2')
    expect(mounts[0]!.totalLines).toBe(120)
    expect(mounts[0]!.ranges).toEqual([{ start: 1, end: 20, expired: 0 }])
    expect(mounts[0]!.mountKind).toBe('remount')
    expect(mounts[0]!.savedTokens).toBe(9)
  })

  it('accumulates savedTokens across same-hash increments and dedups', () => {
    const mounts = foldMounts([
      contextNode(mountSource(), 1),
      contextNode(mountSource({ added: [{ start: 51, end: 60 }], mountKind: 'increment', savedTokens: 8 }), 2),
      contextNode(mountSource({ added: [], mountKind: 'dedup', savedTokens: 5 }), 3),
    ])
    expect(mounts[0]!.savedTokens).toBe(13)
  })

  it('skips foreign nodes and malformed sources', () => {
    const user: ConversationNode = {
      kind: 'user',
      messageId: 'm1' as never,
      seq: 5,
      time: 5000,
      content: [],
      source: { kind: 'user' },
    }
    const mounts = foldMounts([
      user,
      contextNode({ kind: 'plugin', plugin: 'other' }, 6),
      contextNode({ kind: 'user' }, 7),
      contextNode(mountSource({ path: '' }), 8),
      contextNode(mountSource({ mounted: [{ start: 5, end: 2 }] }), 9),
      contextNode(mountSource({ mountKind: 'weird' }), 10),
    ])
    expect(mounts).toEqual([])
  })

  it('keeps separate files as separate entries sorted by seq', () => {
    const mounts = foldMounts([
      contextNode(mountSource({ path: 'b.ts', mounted: [{ start: 1, end: 2 }], added: [{ start: 1, end: 2 }] }), 2),
      contextNode(mountSource(), 1),
    ])
    expect(mounts.map((m) => m.path)).toEqual(['src/a.ts', 'b.ts'])
  })
})

describe('freshnessLevel', () => {
  it('maps drift from the context tail to display levels', () => {
    expect(freshnessLevel(90, 100)).toBe('fresh')      // drift 0.10
    expect(freshnessLevel(70, 100)).toBe('ok')         // drift 0.30
    expect(freshnessLevel(30, 100)).toBe('warn')       // drift 0.70
    expect(freshnessLevel(5, 100)).toBe('expired')     // drift 0.95
    expect(freshnessLevel(undefined, 100)).toBe('unknown')
    expect(freshnessLevel(50, undefined)).toBe('unknown')
  })

  it('respects the configured threshold', () => {
    expect(freshnessLevel(50, 100, 0.3)).toBe('expired') // drift 0.5 > 0.3
    expect(freshnessLevel(50, 100, 0.9)).toBe('ok')
  })
})

describe('foldMounts freshness', () => {
  function assistantNode(seq: number, inputTokens: number, cacheReadTokens = 0): ConversationNode {
    return {
      kind: 'assistant',
      seq,
      time: seq * 1000,
      turn: 1,
      step: 1,
      blocks: [],
      usage: { inputTokens, outputTokens: 1, ...cacheReadTokens > 0 ? { cacheReadTokens } : {} },
      messageId: 'm' + seq as never,
    } as unknown as ConversationNode
  }

  it('derives the context length from assistant usage and carries segment meta', () => {
    const mounts = foldMounts([
      assistantNode(1, 200),
      contextNode(mountSource({
        mounted: [{ start: 1, end: 50, born: 150, expired: 1 }],
        freshnessThreshold: 0.5,
      }), 2),
      assistantNode(3, 400),
    ])
    expect(mounts[0]!.contextL).toBe(400)
    expect(mounts[0]!.freshnessThreshold).toBe(0.5)
    expect(mounts[0]!.ranges).toEqual([{ start: 1, end: 50, born: 150, expired: 1 }])
  })

  it('counts cached input in the context length (uncached + cacheRead)', () => {
    // DSH usage counts are disjoint: inputTokens is uncached only, the cached
    // prefix is cacheReadTokens — the full prompt is their sum.
    const mounts = foldMounts([
      assistantNode(1, 200, 800),
      contextNode(mountSource({ mounted: [{ start: 1, end: 50, born: 900, expired: 0 }] }), 2),
    ])
    expect(mounts[0]!.contextL).toBe(1000)
    // born 900 at L 1000 -> drift 0.10 -> fresh; the uncached-only 200 would
    // have made the same segment "impossibly fresh" forever.
    expect(freshnessLevel(900, mounts[0]!.contextL)).toBe('fresh')
  })
})
