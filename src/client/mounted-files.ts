/**
 * Pure client-side fold of the mount ledger: one entry per mounted file,
 * upserted from the plugin-injected context messages in conversation-node
 * order. The host's structured message source is the durable carrier, so
 * this fold works live and on resumed history alike.
 */
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { normalize } from '../ranges.ts'
import type { Segment } from '../types.ts'

/** One mounted file as the view presents it. */
export interface MountedFileView {
  /** Normalized absolute path (ledger identity). */
  path: string
  /** Short (8-char) content hash for the identity column. */
  hash: string
  /** Line count of the file at hash time. */
  totalLines: number
  /** Mounted ranges, normalized ascending. */
  ranges: Segment[]
  /** How the ledger changed last. */
  mountKind: 'new' | 'increment' | 'remount' | 'dedup'
  /** Cumulative tokens kept out of the context for this path. */
  savedTokens: number
  /** Source message seq (stable ordering). */
  seq: number
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

/**
 * Fold conversation nodes into the mounted-file list. Foreign or malformed
 * nodes are skipped; a hash change replaces the entry wholesale (the old
 * mount is stale), same-hash messages union their ranges.
 */
export function foldMounts(nodes: readonly ConversationNode[]): MountedFileView[] {
  const byPath = new Map<string, MountedFileView>()
  for (const node of nodes) {
    if (node.kind !== 'context' || !isRecord(node.source)) continue
    const source = node.source
    if (source['kind'] !== 'plugin' || source['plugin'] !== 'file-mount') continue
    const { path, hash, totalLines, mounted, mountKind, savedTokens } = source
    if (typeof path !== 'string' || path.length === 0
      || typeof hash !== 'string' || hash.length === 0
      || typeof totalLines !== 'number' || !Number.isSafeInteger(totalLines) || totalLines < 1
      || (mountKind !== 'new' && mountKind !== 'increment' && mountKind !== 'remount' && mountKind !== 'dedup')
      || !Array.isArray(mounted) || mounted.length === 0
      || !mounted.every(isValidSegment)) continue
    const saved = typeof savedTokens === 'number' && Number.isSafeInteger(savedTokens) && savedTokens >= 0
      ? savedTokens
      : 0
    const existing = byPath.get(path)
    if (existing !== undefined && existing.hash === hash) {
      byPath.set(path, {
        ...existing,
        ranges: normalize([...existing.ranges, ...mounted]),
        mountKind,
        savedTokens: existing.savedTokens + saved,
        seq: node.seq,
      })
    } else {
      byPath.set(path, {
        path,
        hash,
        totalLines,
        ranges: normalize(mounted),
        mountKind,
        savedTokens: (existing?.savedTokens ?? 0) + saved,
        seq: node.seq,
      })
    }
  }
  return [...byPath.values()].sort((a, b) => a.seq - b.seq)
}