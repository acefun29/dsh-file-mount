import { describe, expect, it } from 'vitest'
import type { ConversationNode, ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import {
  FRESHNESS_TIERS,
  MountFold,
  foldMounts,
  freshnessLevel,
  nearestTier,
  tierOf,
  worstFreshness,
} from '../../src/client/mounted-files.ts'

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
  const tight = { contextWindow: 800, safeTokens: 100 }

  it('keeps short contexts fresh', () => {
    expect(freshnessLevel(50, 1000)).toBe('fresh')
    expect(freshnessLevel(500, 1000)).toBe('fresh')
    expect(freshnessLevel(undefined, 1000)).toBe('unknown')
    expect(freshnessLevel(500, undefined)).toBe('unknown')
  })

  it('maps pressure × depth to display levels in a filling window', () => {
    expect(freshnessLevel(680, 700, 0.6, 0, tight)).toBe('fresh')
    expect(freshnessLevel(50, 700, 0.6, 0, tight)).toBe('expired')
  })

  it('respects the configured threshold', () => {
    const scoreish = freshnessLevel(50, 700, 0.05, 0, tight)
    expect(scoreish).not.toBe('expired')
    expect(freshnessLevel(50, 700, 0.9, 0, tight)).toBe('expired')
  })

  it('pins expired >= pinAfter as fresh', () => {
    expect(freshnessLevel(50, 700, 0.6, 0, { ...tight, expired: 1 })).toBe('fresh')
  })
})

describe('worstFreshness', () => {
  it('does not paint unknown as fresh', () => {
    expect(worstFreshness(['unknown'])).toBe('unknown')
    expect(worstFreshness([])).toBe('unknown')
    expect(worstFreshness(['unknown', 'fresh'])).toBe('unknown')
  })

  it('ranks expired above warn above ok above unknown above fresh', () => {
    expect(worstFreshness(['fresh', 'ok', 'warn', 'expired'])).toBe('expired')
    expect(worstFreshness(['fresh', 'ok', 'warn'])).toBe('warn')
    expect(worstFreshness(['fresh', 'ok'])).toBe('ok')
    expect(worstFreshness(['fresh'])).toBe('fresh')
  })
})

describe('freshness tiers', () => {
  it('maps each tier id to its threshold (score below it counts as expired)', () => {
    expect(tierOf('lenient')).toBe(0.45)
    expect(tierOf('standard')).toBe(0.55)
    expect(tierOf('sensitive')).toBe(0.65)
    expect(tierOf('aggressive')).toBe(0.75)
    expect(FRESHNESS_TIERS).toHaveLength(4)
  })

  it('picks the nearest tier for an arbitrary threshold', () => {
    expect(nearestTier(0.45)).toBe('lenient')
    expect(nearestTier(0.56)).toBe('standard')
    expect(nearestTier(0.66)).toBe('sensitive')
    expect(nearestTier(0.74)).toBe('aggressive')
    expect(nearestTier(0)).toBe('lenient')
    expect(nearestTier(1)).toBe('aggressive')
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
      contextNode(mountSource({ mounted: [{ start: 1, end: 50, born: 950, expired: 0 }] }), 2),
    ])
    expect(mounts[0]!.contextL).toBe(1000)
    // born 950 at L 1000 is still inside Lsafe (16k) → score 1 → fresh.
    expect(freshnessLevel(950, mounts[0]!.contextL)).toBe('fresh')
  })
})

describe('MountFold (paginated history window)', () => {
  it('keeps entries whose mount messages scroll out of the loaded window', () => {
    const fold = new MountFold()
    const early = contextNode(mountSource({
      path: 'src/a.ts',
      mounted: [{ start: 1, end: 50 }],
      added: [{ start: 1, end: 50 }],
    }), 1)
    const late = contextNode(mountSource({
      path: 'src/b.ts',
      mounted: [{ start: 1, end: 2 }],
      added: [{ start: 1, end: 2 }],
    }), 2)
    expect(fold.fold('s1', [early, late]).map((m) => m.path)).toEqual(['src/a.ts', 'src/b.ts'])
    // The window truncates at the head: only b.ts is delivered now, but the
    // fold remembers a.ts (its message simply scrolled out of the window).
    const views = fold.fold('s1', [late])
    expect(views.map((m) => m.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(views[0]!.ranges).toEqual([{ start: 1, end: 50, expired: 0 }])
  })

  it('resets when the conversation changes', () => {
    const fold = new MountFold()
    fold.fold('s1', [contextNode(mountSource(), 1)])
    expect(fold.fold('s2', [])).toEqual([])
  })

  it('folds re-delivered messages exactly once (no double token counts)', () => {
    const fold = new MountFold()
    const nodes = [
      contextNode(mountSource(), 1),
      contextNode(mountSource({ added: [], mountKind: 'dedup', savedTokens: 5 }), 2),
    ]
    fold.fold('s1', nodes)
    const views = fold.fold('s1', nodes)
    expect(views).toHaveLength(1)
    expect(views[0]!.savedTokens).toBe(5)
  })

  it('re-derives a path in seq order when older messages arrive after newer ones (page up)', () => {
    const fold = new MountFold()
    // The window first delivers only the newer remount (hash h2); a later
    // page-up delivers the older anchor (hash h1) BEFORE it in seq. The
    // final state must stay h2 — arrival order must not overwrite it.
    const remount = contextNode(mountSource({
      hash: 'h2',
      totalLines: 120,
      mounted: [{ start: 1, end: 20 }],
      added: [{ start: 1, end: 20 }],
      mountKind: 'remount',
    }), 9)
    fold.fold('s1', [remount])
    const views = fold.fold('s1', [contextNode(mountSource(), 1), remount])
    expect(views).toHaveLength(1)
    expect(views[0]!.hash).toBe('h2')
    expect(views[0]!.totalLines).toBe(120)
    expect(views[0]!.ranges).toEqual([{ start: 1, end: 20, expired: 0 }])
  })
})
