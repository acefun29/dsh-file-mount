/**
 * Verified file-content cache (ported from piwpi's file-cache.ts, trimmed to
 * the mount plugin's v1 scope): disk is the single source of truth, this
 * module is the ledger's only read path for file identity.
 *
 * Invariants:
 * - get() stats first (bigint); a cache hit requires mtime+size equality AND
 *   TTL freshness, and returns the SAME entry object (reference identity is
 *   the public fast-path signal).
 * - The recorded stat is the PRE-READ stat: concurrent double reads cannot
 *   poison the cache, an overwritten read only forces the next miss.
 * - TTL is the safety valve for content changed under an unchanged mtime+size
 *   (e.g. git restoring timestamps): after expiry the entry re-reads once.
 * - Pinned entries (mounted files) are skipped by capacity eviction; bigint
 *   values stay in memory only (JSON cannot serialize them).
 */
import { readFile, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { hashBuffer } from './hash.ts'

/** One cached identity record for a file. */
export interface FileCacheEntry {
  /** Pre-read stat mtime in nanoseconds. */
  mtimeNs: bigint
  /** Pre-read stat byte size. */
  size: bigint
  /** sha256 hex of the raw bytes. */
  hash: string
}

/** Injectables kept narrow for deterministic tests. */
export interface FileCacheOptions {
  capacity?: number
  ttlMs?: number
  readFile?: typeof readFile
  stat?: typeof stat
}

/** TTL safety valve: same stat but changed content re-reads after this. */
const DEFAULT_TTL_MS = 300_000
/** Global capacity; pinned (mounted) entries are exempt from eviction. */
const DEFAULT_CAPACITY = 32

export class FileContentCache {
  private byPath = new Map<string, { entry: FileCacheEntry; lastVerified: number }>()
  private pinned = new Set<string>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly readFile: typeof readFile
  private readonly stat: typeof stat

  constructor(opts: FileCacheOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.readFile = opts.readFile ?? readFile
    this.stat = opts.stat ?? stat
  }

  /** Pin a mounted file: LRU eviction skips it while it stays in context. */
  pin(absPath: string): void {
    this.pinned.add(absPath)
  }

  /** Unpin after a mount is invalidated; the entry then ages out naturally. */
  unpin(absPath: string): void {
    this.pinned.delete(absPath)
  }

  /**
   * Verified identity read: stat match within TTL returns the cached entry
   * with zero disk reads; otherwise read + hash + refresh. Returns null when
   * the file cannot be stat'ed or read (caller passes through natively).
   */
  async get(absPath: string): Promise<FileCacheEntry | null> {
    let st: BigIntStats
    try {
      st = await this.stat(absPath, { bigint: true })
    } catch {
      this.byPath.delete(absPath)
      return null
    }
    const now = Date.now()
    const cached = this.byPath.get(absPath)
    if (
      cached &&
      cached.entry.mtimeNs === st.mtimeNs &&
      cached.entry.size === st.size &&
      now - cached.lastVerified < this.ttlMs
    ) {
      return cached.entry
    }
    let buf: Buffer
    try {
      buf = await this.readFile(absPath)
    } catch {
      this.byPath.delete(absPath)
      return null
    }
    const entry: FileCacheEntry = {
      mtimeNs: st.mtimeNs,
      size: st.size,
      hash: hashBuffer(buf),
    }
    this.byPath.set(absPath, { entry, lastVerified: now })
    this.evict()
    return entry
  }

  /** Evict the least-recently-verified unpinned entry when over capacity. */
  private evict(): void {
    if (this.byPath.size <= this.capacity) return
    let oldestKey: string | undefined
    let oldestAt = Infinity
    for (const [key, v] of this.byPath) {
      if (this.pinned.has(key)) continue
      if (v.lastVerified < oldestAt) {
        oldestAt = v.lastVerified
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) this.byPath.delete(oldestKey)
  }
}
