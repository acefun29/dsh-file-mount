import { describe, expect, it } from 'vitest'
import { MountStore, type ReplayRecord } from '../src/store.ts'

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

  it('replays mounted and invalidated records in log order', () => {
    const store = new MountStore()
    const records: ReplayRecord[] = [
      { type: 'file-mount/mounted', data: { path: 'a.ts', hash: 'h1', totalLines: 100, segment: { start: 1, end: 50 }, kind: 'new' } },
      { type: 'file-mount/mounted', data: { path: 'a.ts', hash: 'h1', totalLines: 100, segment: { start: 80, end: 100 }, kind: 'increment' } },
      { type: 'file-mount/invalidated', data: { path: 'a.ts', oldHash: 'h1', newHash: 'h2' } },
      { type: 'file-mount/mounted', data: { path: 'a.ts', hash: 'h2', totalLines: 120, segment: { start: 1, end: 20 }, kind: 'remount' } },
    ]
    store.replay(records)
    expect(store.get('a.ts')).toEqual({ absPath: 'a.ts', hash: 'h2', totalLines: 120, segments: [{ start: 1, end: 20 }] })
  })

  it('ignores unknown and malformed records', () => {
    const store = new MountStore()
    store.replay([
      { type: 'user/message', data: { content: 'x' } },
      { type: 'file-mount/mounted', data: null },
      { type: 'file-mount/mounted', data: { path: 'a.ts', hash: 42, totalLines: 'x', segment: { start: 1, end: 2 } } },
      { type: 'file-mount/mounted', data: { path: 'a.ts', hash: 'h1', totalLines: 10, segment: { start: 5, end: 2 } } },
      { type: 'file-mount/invalidated', data: { path: 42 } },
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
