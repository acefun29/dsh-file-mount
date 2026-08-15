/**
 * Pure client-side fold of the mount ledger: one entry per mounted file,
 * upserted from the plugin-injected context messages in conversation-node
 * order. The host's structured message source is the durable carrier, so
 * this fold works live and on resumed history alike. Validation and the
 * merge rule come from mount-source.ts — the SAME rule the host replays
 * with (plan item 20).
 *
 * Freshness (attention-decay plan): assistant nodes expose per-request usage,
 * so the fold also derives the current context length — the FULL prompt
 * (uncached input + cacheRead + cacheWrite; DSH counts are disjoint) — and
 * each segment's `born` position then maps to a display level (fresh/ok/warn/
 * expired/unknown) via the threshold the host stamped on the source.
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
  /** Current context length (latest request input tokens), for freshness. */
  contextL?: number
  /** Freshness expiry threshold the host configured (default 0.85). */
  freshnessThreshold: number
}

/** Display levels for one segment's freshness. */
export type FreshnessLevel = 'fresh' | 'ok' | 'warn' | 'expired' | 'unknown'

/**
 * Freshness level from the attention-decay drift model: r = (L - born) / L
 * is how far the segment has drifted from the context tail (fresh = tail
 * attention zone, > threshold = pushed past the head zone = expired).
 */
export function freshnessLevel(
  born: number | undefined,
  contextL: number | undefined,
  threshold = 0.85,
): FreshnessLevel {
  if (born === undefined || contextL === undefined || contextL < 1) return 'unknown'
  if (born >= contextL) return 'fresh'
  const drift = (contextL - born) / contextL
  if (drift > threshold) return 'expired'
  if (drift > 0.5) return 'warn'
  if (drift > 0.15) return 'ok'
  return 'fresh'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Full prompt length of an assistant node's usage, or undefined when absent.
 * DSH's TokenUsage counts are DISJOINT: `inputTokens` is the uncached input
 * only, with the cached prefix reported separately as cacheReadTokens /
 * cacheWriteTokens — the real context length is the sum of all three.
 */
function contextLengthOf(node: ConversationNode): number | undefined {
  if (node.kind !== 'assistant') return undefined
  const usage = (node as unknown as Record<string, unknown>)['usage']
  if (!isRecord(usage)) return undefined
  const parts = [usage['inputTokens'], usage['cacheReadTokens'], usage['cacheWriteTokens']]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  if (parts.length === 0) return undefined
  return parts.reduce((total, part) => total + part, 0)
}

/**
 * Fold conversation nodes into the mounted-file list. Foreign or malformed
 * nodes are skipped; a hash change replaces the entry wholesale (the old
 * mount is stale), same-hash messages union their ranges. The latest
 * assistant usage sets the context length every view carries for freshness.
 */
export function foldMounts(nodes: readonly ConversationNode[]): MountedFileView[] {
  const byPath = new Map<string, MountedFileView>()
  let contextL: number | undefined
  let threshold = 0.85
  for (const node of nodes) {
    const tokens = contextLengthOf(node)
    if (tokens !== undefined) contextL = tokens
    if (node.kind !== 'context') continue
    const parsed = parseMountSource(node.source)
    if (parsed === undefined) continue
    const existing = byPath.get(parsed.path)
    const state = existing !== undefined
      ? { hash: existing.hash, totalLines: existing.totalLines, segments: existing.ranges, savedTokens: existing.savedTokens, spentTokens: existing.spentTokens }
      : undefined
    const next = applyMountState(state, parsed.delta)
    if (isRecord(node.source) && typeof node.source['freshnessThreshold'] === 'number') {
      threshold = node.source['freshnessThreshold'] as number
    }
    byPath.set(parsed.path, {
      path: parsed.path,
      mountKind: parsed.mountKind,
      seq: node.seq,
      hash: next.hash,
      totalLines: next.totalLines,
      ranges: next.segments,
      savedTokens: next.savedTokens,
      spentTokens: next.spentTokens,
      freshnessThreshold: threshold,
    })
  }
  // Every view shows the CURRENT freshness, so stamp the final context length
  // (the last assistant usage) on all entries after the fold completes.
  const views = [...byPath.values()].sort((a, b) => a.seq - b.seq)
  if (contextL !== undefined) {
    for (const view of views) view.contextL = contextL
  }
  return views
}