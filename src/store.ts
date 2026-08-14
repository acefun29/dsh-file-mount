/**
 * Per-session mount ledger. One writer: the plugin's post-execute handler,
 * serialized by the tool pipeline. Replay folds the plugin-injected context
 * messages' structured sources so a resumed session (and the browser client)
 * reconstruct the same state from standard, persistence-safe events. The
 * validation and fold rules live in mount-source.ts, shared with the browser
 * half (plan item 20).
 */
import type { MountedFile, Segment } from './types.ts'
import { applyMountState, parseMountSource } from './mount-source.ts'

/** One user/message record as the ledger consumer reads it. */
export interface LedgerRecord {
  type: string
  source: unknown
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
   * Union a mounted window into the ledger via the shared fold rule. A hash
   * mismatch proves the on-disk content changed, so the previous entry is
   * replaced wholesale; saved/spent totals are session-cumulative and survive
   * a hash-change replacement.
   */
  mount(file: MountedFile): void {
    const existing = this.files.get(file.absPath)
    const next = applyMountState(existing, {
      hash: file.hash,
      totalLines: file.totalLines,
      segments: file.segments,
      savedTokens: file.savedTokens ?? 0,
      spentTokens: file.spentTokens ?? 0,
    })
    this.files.set(file.absPath, { absPath: file.absPath, ...next })
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
      if (record.type !== 'user/message') continue
      const parsed = parseMountSource(record.source)
      if (parsed === undefined) continue
      const existing = this.files.get(parsed.path)
      this.files.set(parsed.path, { absPath: parsed.path, ...applyMountState(existing, parsed.delta) })
    }
  }

  clear(): void {
    this.files.clear()
  }
}
