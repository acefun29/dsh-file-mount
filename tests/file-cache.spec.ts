import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileContentCache } from '../src/file-cache.ts'
import { fingerprintLines, hashBuffer } from '../src/hash.ts'

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
    cache.pin(a, 's1')
    await cache.get(b)
    await cache.get(c)
    expect(await cache.get(a)).toBe(entryA)
    cache.unpin(a, 's1')
  })

  it('counts pins per session key (one release keeps the other)', async () => {
    const cache = new FileContentCache({ capacity: 2 })
    const entryA = await cache.get(a)
    cache.pin(a, 's1')
    cache.pin(a, 's2')
    await cache.get(b)
    await cache.get(c)
    expect(await cache.get(a)).toBe(entryA)
    cache.unpin(a, 's1')
    await cache.get(b)
    expect(await cache.get(a)).toBe(entryA)
    cache.unpin(a, 's2')
  })

  it('unpinAll releases only that session\'s pins', async () => {
    const cache = new FileContentCache({ capacity: 2 })
    const entryA = await cache.get(a)
    cache.pin(a, 's1')
    cache.pin(a, 's2')
    cache.unpinAll('s1')
    await cache.get(b)
    await cache.get(c)
    expect(await cache.get(a)).toBe(entryA)
    cache.unpinAll('s2')
    await cache.get(b)
    await cache.get(c)
    expect(await cache.get(a)).not.toBe(entryA)
  })

  it('computes the same identity as a direct file read', async () => {
    const cache = new FileContentCache()
    const entry = await cache.get(b)
    expect(entry!.hash).toBe(hashBuffer(await readFile(b)))
  })

  it('returns the current entry with changed=false on a fresh miss', async () => {
    const cache = new FileContentCache()
    const lookup = await cache.lookup(a)
    expect(lookup).not.toBeNull()
    expect(lookup!.changed).toBe(false)
    expect(lookup!.previous).toBeUndefined()
  })

  it('returns previous and changed when content changes', async () => {
    const cache = new FileContentCache()
    const first = await cache.get(a)
    await writeFile(a, 'alpha\nbeta\ngamma\n', 'utf8')
    const lookup = await cache.lookup(a)
    expect(lookup!.changed).toBe(true)
    expect(lookup!.previous!.hash).toBe(first!.hash)
    expect(lookup!.current.hash).not.toBe(first!.hash)
  })

  it('merges concurrent reads into one readFile call', async () => {
    let reads = 0
    const cache = new FileContentCache({
      readFile: async (path) => {
        reads++
        return await readFile(path)
      },
    })
    const [r1, r2] = await Promise.all([cache.lookup(a), cache.lookup(a)])
    expect(reads).toBe(1)
    expect(r1!.current).toBe(r2!.current)
  })

  it('stores per-line fingerprints for small files', async () => {
    const cache = new FileContentCache()
    const entry = await cache.get(b)
    expect(entry!.lineHashes).toHaveLength(3)
    expect(entry!.lineCount).toBe(3)
  })

  it('skips fingerprints for files over the size cap', async () => {
    const cache = new FileContentCache({ maxFingerprintBytes: 10 })
    const entry = await cache.get(a)
    expect(entry!.lineHashes).toHaveLength(0)
    expect(entry!.lineCount).toBe(0)
  })

  it('returns null for files over the management cap (plan item 7)', async () => {
    const cache = new FileContentCache({ maxManagedBytes: 5 })
    expect(await cache.get(a)).toBeNull()
  })

  it('invalidate forgets the cached entry (write/forget paths)', async () => {
    const cache = new FileContentCache()
    const first = await cache.get(a)
    cache.invalidate(a)
    const second = await cache.get(a)
    expect(second).not.toBe(first)
  })

  it('markStale keeps the draft so the next lookup returns previous', async () => {
    const cache = new FileContentCache()
    const first = await cache.get(a)
    cache.markStale(a)
    await writeFile(a, 'alpha\nBETA\n', 'utf8')
    const lookup = await cache.lookup(a)
    expect(lookup!.changed).toBe(true)
    expect(lookup!.previous).toBe(first)
    expect(lookup!.current.hash).not.toBe(first!.hash)
  })

  it('markStale forces a re-read even when stat still matches', async () => {
    let reads = 0
    const cache = new FileContentCache({
      readFile: async (path) => {
        reads++
        return readFile(path)
      },
    })
    await cache.get(a)
    expect(reads).toBe(1)
    cache.markStale(a)
    await cache.get(a)
    expect(reads).toBe(2)
  })

  it('does not write back a lookup that finished after invalidate', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    const cache = new FileContentCache({
      readFile: async (path) => {
        reads++
        if (reads === 1) await gate
        return readFile(path)
      },
    })
    const inflight = cache.lookup(a)
    await vi.waitFor(() => { expect(reads).toBe(1) })
    cache.invalidate(a)
    release()
    await inflight
    await cache.lookup(a)
    expect(reads).toBe(2)
  })
})

describe('fingerprintLines', () => {
  it('splits on newlines and returns one fingerprint per line', () => {
    expect(fingerprintLines(Buffer.from('a\nb\nc\n', 'utf8'))).toHaveLength(3)
  })

  it('does not add a trailing empty line for a trailing newline', () => {
    expect(fingerprintLines(Buffer.from('a\nb\n', 'utf8'))).toHaveLength(2)
    expect(fingerprintLines(Buffer.from('a\nb', 'utf8'))).toHaveLength(2)
  })

  it('treats an empty file as zero lines', () => {
    expect(fingerprintLines(Buffer.from('', 'utf8'))).toHaveLength(0)
  })

  it('counts an interior empty line', () => {
    expect(fingerprintLines(Buffer.from('a\n\nb\n', 'utf8'))).toHaveLength(3)
  })

  it('strips CRLF so LF and CRLF versions share fingerprints', () => {
    expect(fingerprintLines(Buffer.from('a\r\nb\r\n', 'utf8'))).toEqual(fingerprintLines(Buffer.from('a\nb\n', 'utf8')))
  })

  it('equals for equal content and differs for different content', () => {
    expect(fingerprintLines(Buffer.from('x\ny', 'utf8'))).toEqual(fingerprintLines(Buffer.from('x\ny', 'utf8')))
    expect(fingerprintLines(Buffer.from('x\ny', 'utf8'))).not.toEqual(fingerprintLines(Buffer.from('x\nz', 'utf8')))
  })
})
