import { readFile, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { fingerprintLines, hashBuffer } from './hash.ts'

/**
 * Verified file-content cache: disk is the single source of truth, this
 * module is the ledger's only read path for file identity.
 *
 * Invariants:
 * - lookup() stats first (bigint); a cache hit needs mtime+size equality AND
 *   TTL freshness, and returns the SAME entry object (reference identity is
 *   the public fast-path signal).
 * - The recorded stat is the PRE-READ stat: concurrent double reads cannot
 *   poison the cache, an overwritten read only forces the next miss.
 * - TTL is the safety valve for content changed under an unchanged mtime+size
 *   (e.g. git restoring timestamps): after expiry the entry re-reads once.
 * - Pinned entries (mounted files) skip capacity eviction; pins are
 *   reference-counted per session key so one teardown never drops another
 *   session's pin. Bigint values stay in memory only (JSON cannot serialize
 *   them).
 * - Concurrent reads of the same path merge onto one in-flight read, so the
 *   file is read once and every caller shares the result.
 * - Entries carry per-line fingerprints (the draft) for incremental
 *   remounting; files over the size cap keep no fingerprints and fall back
 *   to a whole-window remount.
 */

/** One cached identity record for a file. */
export interface FileCacheEntry {
  /** Pre-read stat mtime in nanoseconds. */
  mtimeNs: bigint
  /** Pre-read stat byte size. */
  size: bigint
  /** sha256 hex of the raw bytes. */
  hash: string
  /** Per-line fingerprints in line order (index 0 = line 1); empty when capped. */
  lineHashes: string[]
  /** lineHashes.length (0 when the draft was skipped). */
  lineCount: number
}

/**
 * One verified identity read: the current entry plus, when the on-disk
 * content changed since the cache last saw it, the previous entry.
 * previous is the draft item 9 diffs against; callers must confirm its
 * hash matches their ledger before diffing.
 */
export interface CacheLookup {
  current: FileCacheEntry
  previous?: FileCacheEntry
  /** True when the content changed (current.hash !== previous.hash). */
  changed: boolean
}

/** Injectables kept narrow for deterministic tests. */
export interface FileCacheOptions {
  capacity?: number
  ttlMs?: number
  /** Files larger than this keep no line fingerprints (whole-window remount). */
  maxFingerprintBytes?: number
  /** Files larger than this are not managed at all (never read or cached). */
  maxManagedBytes?: number
  readFile?: typeof readFile
  stat?: typeof stat
}

/** TTL safety valve: same stat but changed content re-reads after this. */
const DEFAULT_TTL_MS = 300_000
/** Global capacity; pinned (mounted) entries are exempt from eviction. */
const DEFAULT_CAPACITY = 32
/** Draft cap: files above this size keep no per-line fingerprints. */
const DEFAULT_MAX_FINGERPRINT_BYTES = 1_000_000
/** Management cap: files above this size pass through untouched (plan item 7). */
const DEFAULT_MAX_MANAGED_BYTES = 16 * 1024 * 1024

export class FileContentCache {
  private byPath = new Map<string, { entry: FileCacheEntry; lastVerified: number; stale: boolean }>()
  /** Mounted-file pins: path -> the session keys currently pinning it. */
  private pinned = new Map<string, Set<string>>()
  /** In-flight reads by path: concurrent lookups share one read. */
  private inFlight = new Map<string, Promise<CacheLookup | null>>()
  /** In-flight lookup generations: invalidate bumps so a completing read cannot write a stale entry back. */
  private epoch = new Map<string, number>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly maxFingerprintBytes: number
  private readonly maxManagedBytes: number
  private readonly readFile: typeof readFile
  private readonly stat: typeof stat

  constructor(opts: FileCacheOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxFingerprintBytes = opts.maxFingerprintBytes ?? DEFAULT_MAX_FINGERPRINT_BYTES
    this.maxManagedBytes = opts.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES
    this.readFile = opts.readFile ?? readFile
    this.stat = opts.stat ?? stat
  }

  /** Pin a mounted file under a session key (idempotent per key). */
  pin(absPath: string, key: string): void {
    let keys = this.pinned.get(absPath)
    if (keys === undefined) {
      keys = new Set()
      this.pinned.set(absPath, keys)
    }
    keys.add(key)
  }

  /** Release one session's pin; the entry becomes evictable at zero pins. */
  unpin(absPath: string, key: string): void {
    const keys = this.pinned.get(absPath)
    if (keys === undefined) return
    keys.delete(key)
    if (keys.size === 0) this.pinned.delete(absPath)
  }

  /** Release every pin a session holds (session teardown / refold). */
  unpinAll(key: string): void {
    for (const [absPath, keys] of this.pinned) {
      keys.delete(key)
      if (keys.size === 0) this.pinned.delete(absPath)
    }
  }

  /** Forget one path's cached identity (write/forget callers). */
  invalidate(absPath: string): void {
    this.byPath.delete(absPath)
    this.inFlight.delete(absPath)
    this.epoch.set(absPath, (this.epoch.get(absPath) ?? 0) + 1)
  }

  /**
   * Mark the cached identity stale without dropping the draft. The next
   * lookup always re-reads the disk, but `previous` still carries the
   * retained line fingerprints so an edit can remount only the changed lines.
   */
  markStale(absPath: string): void {
    const cached = this.byPath.get(absPath)
    if (cached === undefined) return
    this.byPath.set(absPath, { ...cached, stale: true })
  }

  /**
   * Verified identity read: stat match within TTL returns the cached entry
   * with zero disk reads; otherwise read + hash + refresh, returning the
   * previous entry when the content changed. Returns null when the file
   * cannot be stat'ed or read (caller passes through natively).
   */
  async lookup(absPath: string): Promise<CacheLookup | null> {
    let st: BigIntStats
    try {
      st = await this.stat(absPath, { bigint: true })
    } catch {
      this.byPath.delete(absPath)
      return null
    }
    // Files over the management cap pass through untouched: never read,
    // never cached (plan item 7 keeps huge files out of the plugin's hands).
    if (st.size > BigInt(this.maxManagedBytes)) {
      this.byPath.delete(absPath)
      return null
    }
    const now = Date.now()
    const cached = this.byPath.get(absPath)
    if (
      cached &&
      !cached.stale &&
      cached.entry.mtimeNs === st.mtimeNs &&
      cached.entry.size === st.size &&
      now - cached.lastVerified < this.ttlMs
    ) {
      return { current: cached.entry, changed: false }
    }
    // Miss, expiry, or stale: (re)read, sharing one in-flight read per path.
    let pending = this.inFlight.get(absPath)
    if (pending === undefined) {
      const epochAtStart = this.epoch.get(absPath) ?? 0
      pending = (async () => {
        let buf: Buffer
        try {
          buf = await this.readFile(absPath)
        } catch {
          if ((this.epoch.get(absPath) ?? 0) === epochAtStart) this.byPath.delete(absPath)
          return null
        }
        const entry = this.buildEntry(st, buf)
        const previous = cached?.entry
        const changed = previous !== undefined && previous.hash !== entry.hash
        const result = changed ? { current: entry, previous, changed: true as const } : { current: entry, changed: false as const }
        if ((this.epoch.get(absPath) ?? 0) !== epochAtStart) return result
        this.byPath.set(absPath, { entry, lastVerified: Date.now(), stale: false })
        this.evict()
        return result
      })().finally(() => { this.inFlight.delete(absPath) })
      this.inFlight.set(absPath, pending)
    }
    return pending
  }

  /** Legacy single-entry view (current entry only). */
  async get(absPath: string): Promise<FileCacheEntry | null> {
    const result = await this.lookup(absPath)
    return result?.current ?? null
  }

  /** Build the identity + draft for one freshly-read buffer. */
  private buildEntry(st: BigIntStats, buf: Buffer): FileCacheEntry {
    const lineHashes = st.size <= BigInt(this.maxFingerprintBytes) ? fingerprintLines(buf) : []
    return {
      mtimeNs: st.mtimeNs,
      size: st.size,
      hash: hashBuffer(buf),
      lineHashes,
      lineCount: lineHashes.length,
    }
  }

  /** Evict the least-recently-verified unpinned entry when over capacity. */
  private evict(): void {
    if (this.byPath.size <= this.capacity) return
    let oldestKey: string | undefined
    let oldestAt = Infinity
    for (const [key, v] of this.byPath) {
      if ((this.pinned.get(key)?.size ?? 0) > 0) continue
      if (v.lastVerified < oldestAt) {
        oldestAt = v.lastVerified
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) this.byPath.delete(oldestKey)
  }
}
