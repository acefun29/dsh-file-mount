/**
 * Pure client-side fold of the mount ledger: one entry per mounted file,
 * upserted from the plugin-injected context messages in conversation-node
 * order. The host's structured message source is the durable carrier, so
 * this fold works live and on resumed history alike. Validation and the
 * merge rule come from mount-source.ts — the SAME rule the host replays
 * with (plan item 20).
 */
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { LedgerSegment } from '../types.ts'
import { applyMountState, parseMountSource } from '../mount-source.ts'

/** One mounted file as the view presents it. */
export interface MountedFileView {
  /** Normalized absolute path (ledger identity). */
  path: string
  /** Short (8-char) content hash for the identity column. */
  hash: string
  /** Line count of the file at hash time. */
  totalLines: number
  /** Mounted ranges, normalized ascending, with freshness metadata. */
  ranges: LedgerSegment[]
  /** How the ledger changed last. */
  mountKind: 'new' | 'increment' | 'remount' | 'dedup'
  /** Cumulative tokens kept out of the context for this path. */
  savedTokens: number
  /** Cumulative tokens the plugin's own notes cost for this path. */
  spentTokens: number
  /** Source message seq (stable ordering). */
  seq: number
}

/**
 * Fold conversation nodes into the mounted-file list. Foreign or malformed
 * nodes are skipped; a hash change replaces the entry wholesale (the old
 * mount is stale), same-hash messages union their ranges.
 */
export function foldMounts(nodes: readonly ConversationNode[]): MountedFileView[] {
  const byPath = new Map<string, MountedFileView>()
  for (const node of nodes) {
    if (node.kind !== 'context') continue
    const parsed = parseMountSource(node.source)
    if (parsed === undefined) continue
    const existing = byPath.get(parsed.path)
    const state = existing !== undefined
      ? { hash: existing.hash, totalLines: existing.totalLines, segments: existing.ranges, savedTokens: existing.savedTokens, spentTokens: existing.spentTokens }
      : undefined
    const next = applyMountState(state, parsed.delta)
    byPath.set(parsed.path, {
      path: parsed.path,
      mountKind: parsed.mountKind,
      seq: node.seq,
      hash: next.hash,
      totalLines: next.totalLines,
      ranges: next.segments,
      savedTokens: next.savedTokens,
      spentTokens: next.spentTokens,
    })
  }
  return [...byPath.values()].sort((a, b) => a.seq - b.seq)
}
