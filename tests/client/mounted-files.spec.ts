import { describe, expect, it } from 'vitest'
import type { ConversationNode, ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { foldMounts } from '../../src/client/mounted-files.ts'

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
    path: 'src/a.ts',
    hash: 'h1',
    totalLines: 100,
    mounted: [{ start: 1, end: 50 }],
    added: [{ start: 1, end: 50 }],
    mountKind: 'new',
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
    })
  })

  it('unions same-hash increments and keeps the latest kind', () => {
    const mounts = foldMounts([
      contextNode(mountSource(), 1),
      contextNode(mountSource({ mounted: [{ start: 1, end: 80 }], added: [{ start: 51, end: 80 }], mountKind: 'increment' }), 2),
    ])
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.ranges).toEqual([{ start: 1, end: 80 }])
    expect(mounts[0]!.mountKind).toBe('increment')
    expect(mounts[0]!.seq).toBe(2)
  })

  it('replaces the entry wholesale on a hash change', () => {
    const mounts = foldMounts([
      contextNode(mountSource(), 1),
      contextNode(mountSource({ hash: 'h2', totalLines: 120, mounted: [{ start: 1, end: 20 }], added: [{ start: 1, end: 20 }], mountKind: 'remount' }), 2),
    ])
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.hash).toBe('h2')
    expect(mounts[0]!.totalLines).toBe(120)
    expect(mounts[0]!.ranges).toEqual([{ start: 1, end: 20 }])
    expect(mounts[0]!.mountKind).toBe('remount')
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