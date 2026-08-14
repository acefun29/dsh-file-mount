/**
 * Per-session mount ledger. One writer: the plugin's post-execute handler,
 * serialized by the tool pipeline. Replay folds the plugin-injected context
 * messages' structured sources so a resumed session (and the browser client)
 * reconstruct the same state from standard, persistence-safe events.
 */
import { normalize } from './ranges.ts'
import type { MountedFile, Segment } from './types.ts'

/** One user/message record as the ledger consumer reads it. */
export interface LedgerRecord {
  type: string
  source: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidSegment(value: unknown): value is Segment {
  if (!isRecord(value)) return false
  const { start, end } = value
  return typeof start === 'number' && typeof end === 'number'
    && Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= 1 && end >= start
}

export class MountStore {
  private files = new Map<string, MountedFile>()

  get(absPath: string): MountedFile | undefined {
    return this.files.get(absPath)
  }

  all(): MountedFile[] {
    return [...this.files.values()]
  }

  mountedSegments(absPath: string): Segment[] {
    return this.files.get(absPath)?.segments ?? []
  }

  /**
   * Union a mounted window into the ledger. A hash mismatch proves the
   * on-disk content changed, so the previous entry is replaced wholesale
   * (the new window becomes the fresh anchor).
   */
  mount(file: MountedFile): void {
    const existing = this.files.get(file.absPath)
    if (existing !== undefined && existing.hash === file.hash) {
      existing.segments = normalize([...existing.segments, ...file.segments])
    } else {
      this.files.set(file.absPath, file)
    }
  }

  /** Drop one entry (hash change / explicit invalidation). */
  invalidate(absPath: string): void {
    this.files.delete(absPath)
  }

  /**
   * Fold user/message records in log order; a file-mount source updates the
   * ledger with its post-mount ranges. Unknown or malformed records are
   * skipped defensively (foreign logs must never break the ledger).
   */
  replay(records: readonly LedgerRecord[]): void {
    for (const record of records) {
      if (record.type !== 'user/message' || !isRecord(record.source)) continue
      const source = record.source
      if (source['kind'] !== 'plugin' || source['plugin'] !== 'file-mount') continue
      const { path, hash, totalLines, mounted, mountKind } = source
      if (typeof path !== 'string' || path.length === 0
        || typeof hash !== 'string' || hash.length === 0
        || typeof totalLines !== 'number' || !Number.isSafeInteger(totalLines) || totalLines < 1
        || (mountKind !== 'new' && mountKind !== 'increment' && mountKind !== 'remount')
        || !Array.isArray(mounted) || mounted.length === 0
        || !mounted.every(isValidSegment)) continue
      this.mount({ absPath: path, hash, totalLines, segments: mounted })
    }
  }

  clear(): void {
    this.files.clear()
  }
}