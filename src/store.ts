/**
 * Per-session mount ledger. One writer: the plugin's post-execute handler,
 * serialized by the tool pipeline. Replay folds the plugin-injected context
 * messages' structured sources so a resumed session (and the browser client)
 * reconstruct the same state from standard, persistence-safe events. The
 * validation and fold rules live in mount-source.ts, shared with the browser
 * half (plan item 20).
 */
import type { ExpiredSegment, LedgerSegment, MountedFile } from './types.ts'
import { applyMountState, normalizeLedger, parseMountSource, saturatingAdd } from './mount-source.ts'

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

  mountedSegments(absPath: string): LedgerSegment[] {
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
    // Defensive: bare geometry segments (tests / older callers) fold with
    // expired 0 and no born, exactly like a legacy message would.
    const segments = file.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      ...seg.born !== undefined ? { born: seg.born } : {},
      ...seg.tokens !== undefined ? { tokens: seg.tokens } : {},
      expired: seg.expired ?? 0,
    }))
    const next = applyMountState(existing, {
      hash: file.hash,
      totalLines: file.totalLines,
      segments,
      savedTokens: file.savedTokens ?? 0,
      spentTokens: file.spentTokens ?? 0,
    })
    // The caller always passes the latest expired history (pruned + inherited);
    // a same-hash remount keeps the caller's state rather than the stale copy.
    this.files.set(file.absPath, { absPath: file.absPath, ...next, expiredHistory: file.expiredHistory ?? [] })
  }

  /**
   * Explicitly replace active segments and update expired history on an
   * existing entry (e.g. after pruneExpired in full-dedup branches).
   * Unlike `mount()`, this does NOT union old segments back.
   * Saved and spent tokens are accumulated if provided.
   */
  replaceSegments(
    absPath: string,
    segments: readonly LedgerSegment[],
    expiredHistory: readonly ExpiredSegment[],
    savedTokens = 0,
    spentTokens = 0,
  ): void {
    const existing = this.files.get(absPath)
    if (existing === undefined) return
    const normalized = normalizeLedger(segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      ...seg.born !== undefined ? { born: seg.born } : {},
      ...seg.tokens !== undefined ? { tokens: seg.tokens } : {},
      expired: seg.expired ?? 0,
    })))
    this.files.set(absPath, {
      ...existing,
      segments: normalized,
      expiredHistory: [...expiredHistory],
      savedTokens: saturatingAdd(existing.savedTokens, savedTokens),
      spentTokens: saturatingAdd(existing.spentTokens, spentTokens),
    })
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
      // History is host-side only: replay rebuilds from scratch (the next read
      // re-prunes), so restored entries start with an empty history.
      this.files.set(parsed.path, {
        absPath: parsed.path,
        ...applyMountState(existing, parsed.delta),
        expiredHistory: existing?.expiredHistory ?? [],
      })
    }
  }

  clear(): void {
    this.files.clear()
  }
}
