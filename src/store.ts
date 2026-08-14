/**
 * Per-session mount ledger (ported from piwpi's store.ts, refocused on the
 * single-file mount concern). One writer: the plugin's post-execute handler,
 * serialized by the tool pipeline. Replay folds durable `file-mount/*`
 * records so a resumed session reconstructs the same state.
 */
import { normalize } from './ranges.ts'
import type { MountedFile, Segment } from './types.ts'

/** Shape a replay consumer reads: raw event records from the session log. */
export interface ReplayRecord {
  type: string
  data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
   * Fold durable records in log order. Unknown or malformed records are
   * skipped defensively (foreign logs must never break the ledger).
   */
  replay(records: readonly ReplayRecord[]): void {
    for (const record of records) {
      if (record.type === 'file-mount/mounted') {
        const d = isRecord(record.data) ? record.data : undefined
        if (d === undefined) continue
        const { path, hash, totalLines, segment } = d
        if (typeof path !== 'string' || typeof hash !== 'string'
          || typeof totalLines !== 'number' || !isRecord(segment)) continue
        const { start, end } = segment
        if (typeof start !== 'number' || typeof end !== 'number'
          || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start < 1 || end < start) continue
        this.mount({ absPath: path, hash, totalLines, segments: [{ start, end }] })
      } else if (record.type === 'file-mount/invalidated') {
        const d = isRecord(record.data) ? record.data : undefined
        if (d === undefined || typeof d.path !== 'string') continue
        this.invalidate(d.path)
      }
    }
  }

  clear(): void {
    this.files.clear()
  }
}
