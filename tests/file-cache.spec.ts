import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileContentCache } from '../src/file-cache.ts'
import { hashBuffer } from '../src/hash.ts'

describe('hashBuffer', () => {
  it('matches the known sha256 vector', () => {
    expect(hashBuffer(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('distinguishes CRLF from LF bytes', () => {
    expect(hashBuffer(Buffer.from('a\r\nb', 'utf8'))).not.toBe(hashBuffer(Buffer.from('a\nb', 'utf8')))
  })
})

describe('FileContentCache', () => {
  let dir: string
  let a: string
  let b: string
  let c: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-'))
    a = join(dir, 'a.txt')
    b = join(dir, 'b.txt')
    c = join(dir, 'c.txt')
    await writeFile(a, 'alpha\nbeta\n', 'utf8')
    await writeFile(b, 'one\ntwo\nthree\n', 'utf8')
    await writeFile(c, 'first\nsecond\n', 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads and hashes a file on first access', async () => {
    const cache = new FileContentCache()
    const entry = await cache.get(a)
    expect(entry).not.toBeNull()
    expect(entry!.hash).toBe(hashBuffer(Buffer.from('alpha\nbeta\n', 'utf8')))
  })

  it('returns the SAME entry object on an unchanged stat hit (zero re-read)', async () => {
    const cache = new FileContentCache()
    const first = await cache.get(a)
    const second = await cache.get(a)
    expect(second).toBe(first)
  })

  it('re-reads and refreshes when content changes', async () => {
    const cache = new FileContentCache()
    const first = await cache.get(a)
    await writeFile(a, 'alpha\nbeta\ngamma\ndelta\n', 'utf8')
    const second = await cache.get(a)
    expect(second).not.toBeNull()
    expect(second!.hash).not.toBe(first!.hash)
    expect(second).not.toBe(first)
  })

  it('returns null for a missing file', async () => {
    const cache = new FileContentCache()
    expect(await cache.get(join(dir, 'nope.txt'))).toBeNull()
  })

  it('returns null when stat fails', async () => {
    const cache = new FileContentCache({
      stat: async () => {
        throw new Error('stat failed')
      },
    })
    expect(await cache.get(a)).toBeNull()
  })

  it('returns null when readFile fails after a successful stat', async () => {
    const cache = new FileContentCache({
      readFile: async () => {
        throw new Error('read failed')
      },
    })
    expect(await cache.get(a)).toBeNull()
  })

  it('re-reads after the TTL expires even with unchanged stat', async () => {
    vi.useFakeTimers()
    try {
      const cache = new FileContentCache({ ttlMs: 1000 })
      const first = await cache.get(a)
      await vi.advanceTimersByTimeAsync(1001)
      const second = await cache.get(a)
      expect(second).not.toBe(first)
      expect(second!.hash).toBe(first!.hash)
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts the least-recently-verified unpinned entry over capacity', async () => {
    const cache = new FileContentCache({ capacity: 2 })
    const entryA = await cache.get(a)
    await cache.get(b)
    await cache.get(c)
    expect(await cache.get(a)).not.toBe(entryA)
  })

  it('keeps pinned entries across eviction', async () => {
    const cache = new FileContentCache({ capacity: 2 })
    const entryA = await cache.get(a)
    cache.pin(a)
    await cache.get(b)
    await cache.get(c)
    expect(await cache.get(a)).toBe(entryA)
    cache.unpin(a)
  })

  it('computes the same identity as a direct file read', async () => {
    const cache = new FileContentCache()
    const entry = await cache.get(b)
    expect(entry!.hash).toBe(hashBuffer(await readFile(b)))
  })
})
