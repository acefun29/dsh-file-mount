import { describe, expect, it } from 'vitest'
import { MountStore, type LedgerRecord } from '../src/store.ts'

function mountSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'plugin',
    plugin: 'file-mount',
    path: 'a.ts',
    hash: 'h1',
    totalLines: 100,
    mounted: [{ start: 1, end: 50 }],
    added: [{ start: 1, end: 50 }],
    mountKind: 'new',
    ...overrides,
  }
}

function mountRecord(source: Record<string, unknown>): LedgerRecord {
  return { type: 'user/message', source }
}

describe('MountStore', () => {
  it('mounts a new file', () => {
    const store = new MountStore()
    store.mount({ absPath: 'a.ts', hash: 'h1', totalLines: 100, segments: [{ start: 1, end: 50 }] })
    expect(store.get('a.ts')).toEqual({ absPath: 'a.ts', hash: 'h1', totalLines: 100, segments: [{ start: 1, end: 50 }] })
    expect(store.mountedSegments('a.ts')).toEqual([{ start: 1, end: 50 }])
  })

  it('unions ranges on the same hash', () => {
    const store = new MountStore()
    store.mount({ absPath: 'a.ts', hash: 'h1', totalLines: 100, segments: [{ start: 1, end: 50 }] })
    store.mount({ absPath: 'a.ts', hash: 'h1', totalLines: 100, segments: [{ start: 40, end: 80 }] })
    expect(store.mountedSegments('a.ts')).toEqual([{ start: 1, end: 80 }])
  })

  it('replaces the entry wholesale on a hash change', () => {
    const store = new MountStore()
    store.mount({ absPath: 'a.ts', hash: 'h1', totalLines: 100, segments: [{ start: 1, end: 80 }] })
    store.mount({ absPath: 'a.ts', hash: 'h2', totalLines: 120, segments: [{ start: 1, end: 20 }] })
    expect(store.get('a.ts')).toEqual({ absPath: 'a.ts', hash: 'h2', totalLines: 120, segments: [{ start: 1, end: 20 }] })
  })

  it('invalidate drops the entry', () => {
    const store = new MountStore()
    store.mount({ absPath: 'a.ts', hash: 'h1', totalLines: 10, segments: [{ start: 1, end: 10 }] })
    store.invalidate('a.ts')
    expect(store.get('a.ts')).toBeUndefined()
    expect(store.mountedSegments('a.ts')).toEqual([])
  })

  it('replays mount messages in log order (hash change replaces)', () => {
    const store = new MountStore()
    store.replay([
      mountRecord(mountSource()),
      mountRecord(mountSource({ mounted: [{ start: 1, end: 80 }], added: [{ start: 51, end: 80 }], mountKind: 'increment' })),
      mountRecord(mountSource({ hash: 'h2', totalLines: 120, mounted: [{ start: 1, end: 20 }], added: [{ start: 1, end: 20 }], mountKind: 'remount' })),
    ])
    expect(store.get('a.ts')).toEqual({ absPath: 'a.ts', hash: 'h2', totalLines: 120, segments: [{ start: 1, end: 20 }] })
  })

  it('ignores foreign messages and malformed sources', () => {
    const store = new MountStore()
    store.replay([
      { type: 'user/message', source: { kind: 'user' } },
      { type: 'user/message', source: { kind: 'plugin', plugin: 'other-plugin' } },
      { type: 'assistant/message', source: mountSource() },
      { type: 'user/message', source: null },
      { type: 'user/message', source: mountSource({ path: '' }) },
      { type: 'user/message', source: mountSource({ hash: 42 }) },
      { type: 'user/message', source: mountSource({ mounted: [{ start: 5, end: 2 }] }) },
      { type: 'user/message', source: mountSource({ mounted: [] }) },
      { type: 'user/message', source: mountSource({ mountKind: 'weird' }) },
    ])
    expect(store.all()).toEqual([])
  })

  it('clear empties the ledger', () => {
    const store = new MountStore()
    store.mount({ absPath: 'a.ts', hash: 'h1', totalLines: 10, segments: [{ start: 1, end: 10 }] })
    store.clear()
    expect(store.all()).toEqual([])
  })
})