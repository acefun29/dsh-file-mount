/**
 * Client-side fold of the mount ledger: one entry per mounted file, upserted
 * from the plugin-injected context messages in conversation-node order. The
 * host's structured message source is the durable carrier, so this fold works
 * live and on resumed history alike. Validation and the merge rule come from
 * mount-source.ts — the SAME rule the host replays with (plan item 20).
 *
 * The browser conversation is a PAGINATED history window (tail page first,
 * older pages only on scroll), so `snapshot.nodes` shrinks at the head as the
 * session grows. {@link MountFold} therefore persists its per-session state
 * across snapshot revisions: a mount message that scrolls out of the loaded
 * window keeps its file on the dashboard, and re-delivered messages are
 * folded exactly once (no double token counts). `foldMounts` remains as the
 * stateless one-shot fold for tests and one-off consumers.
 *
 * Freshness (attention-decay plan): assistant nodes expose per-request usage,
 * so the fold also derives the current context length — the FULL prompt
 * (uncached input + cacheRead + cacheWrite; DSH counts are disjoint) — and
 * each segment's `born` position then maps to a display level (fresh/ok/warn/
 * expired/unknown) via the threshold the host stamped on the source.
 */
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { LedgerSegment } from '../types.ts'
import {
  applyMountState,
  calculateFreshnessScore,
  DEFAULT_FRESHNESS_CONFIG,
  parseMountSource,
  type FreshnessOptions,
  type MountDelta,
  type MountState,
} from '../mount-source.ts'
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
 * Preset freshness thresholds the dashboard tier picker offers (drift past
 * the threshold counts a segment as expired; higher = more lenient).
 */
export const FRESHNESS_TIERS = [
  { id: 'lenient', threshold: 0.2 },
  { id: 'standard', threshold: 0.3 },
  { id: 'sensitive', threshold: 0.4 },
  { id: 'aggressive', threshold: 0.5 },
] as const
/** Tier ids, in picker order. */
export type FreshnessTierId = (typeof FRESHNESS_TIERS)[number]['id']

/** The threshold of one tier id. */
export function tierOf(id: FreshnessTierId): number {
  const tier = FRESHNESS_TIERS.find((candidate) => candidate.id === id)
  if (tier === undefined) throw new Error(`unknown freshness tier: ${id}`)
  return tier.threshold
}

/** The tier whose threshold is closest to the given value (ties → earlier). */
export function nearestTier(threshold: number): FreshnessTierId {
  let best: (typeof FRESHNESS_TIERS)[number] = FRESHNESS_TIERS[2]!
  let bestDistance = Infinity
  for (const tier of FRESHNESS_TIERS) {
    const distance = Math.abs(tier.threshold - threshold)
    if (distance < bestDistance) {
      bestDistance = distance
      best = tier
    }
  }
  return best.id
}

/** The host settings face the dashboard tier picker writes through (duck-typed; only the fields the panel uses). */
export interface FreshnessSettingsApi {
  update(payload: { ns: string; patch: { freshnessThreshold: number } }): Promise<unknown>
}

/**
 * Freshness level from the attention-decay drift model: r = (L - born) / L
 * is how far the segment has drifted from the context tail (fresh = tail
 * attention zone, > threshold = pushed past the head zone = expired).
 */
export function freshnessLevel(
  born: number | undefined,
  contextL: number | undefined,
  threshold = DEFAULT_FRESHNESS_CONFIG.threshold,
  tokens?: number,
  options?: FreshnessOptions,
): FreshnessLevel {
  if (born === undefined || contextL === undefined || contextL < 1) return 'unknown'
  if (born >= contextL) return 'fresh'
  const score = calculateFreshnessScore(born, contextL, tokens, options)
  if (score < threshold) return 'expired'
  if (score < threshold + 0.15) return 'warn'
  if (score < 0.85) return 'ok'
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

/** One stored mount message for a path, kept for ordered re-derivation. */
interface StoredMount {
  seq: number
  kind: 'new' | 'increment' | 'remount' | 'dedup'
  delta: MountDelta
}

/**
 * Stateful fold that survives the client's paginated history window. Per
 * session it keeps every validated mount message per path and re-derives the
 * entry in seq order on each fold, so (a) messages that scroll out of the
 * loaded window keep their file visible, (b) re-delivered messages fold
 * exactly once, and (c) older messages arriving later (page-up) cannot
 * overwrite newer state. A sessionId change resets the accumulated state.
 */
export class MountFold {
  private sessionId: string | undefined
  private readonly paths = new Map<string, StoredMount[]>()
  private readonly folded = new Set<number>()
  private lastThreshold = DEFAULT_FRESHNESS_CONFIG.threshold
  private lastThresholdSeq = -1
  /**
   * Fold one snapshot revision (ascending seq) into the persistent state.
   * @param sessionId - owning conversation; a change resets the fold.
   * @param nodes - the currently loaded conversation nodes (windowed).
   * @returns the mounted-file views (sorted by last message seq).
   */
  fold(sessionId: string, nodes: readonly ConversationNode[]): MountedFileView[] {
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId
      this.paths.clear()
      this.folded.clear()
      this.lastThreshold = DEFAULT_FRESHNESS_CONFIG.threshold
      this.lastThresholdSeq = -1
    }
    let contextL: number | undefined
    for (const node of nodes) {
      const tokens = contextLengthOf(node)
      if (tokens !== undefined) contextL = tokens
      if (node.kind !== 'context') continue
      const parsed = parseMountSource(node.source)
      if (parsed === undefined) continue
      if (this.folded.has(node.seq)) continue
      this.folded.add(node.seq)
      if (isRecord(node.source) && typeof node.source['freshnessThreshold'] === 'number') {
        const threshold = node.source['freshnessThreshold'] as number
        if (node.seq > this.lastThresholdSeq) {
          this.lastThresholdSeq = node.seq
          this.lastThreshold = threshold
        }
      }
      const list = this.paths.get(parsed.path) ?? []
      list.push({ seq: node.seq, kind: parsed.mountKind, delta: parsed.delta })
      list.sort((a, b) => a.seq - b.seq)
      this.paths.set(parsed.path, list)
    }
    const views: MountedFileView[] = []
    for (const [path, messages] of this.paths) {
      let state: MountState | undefined
      for (const message of messages) state = applyMountState(state, message.delta)
      if (state === undefined) continue
      const last = messages[messages.length - 1]!
      views.push({
        path,
        mountKind: last.kind,
        seq: last.seq,
        hash: state.hash,
        totalLines: state.totalLines,
        ranges: state.segments,
        savedTokens: state.savedTokens,
        spentTokens: state.spentTokens,
        freshnessThreshold: this.lastThreshold,
      })
    }
    views.sort((a, b) => a.seq - b.seq)
    // Every view shows the CURRENT freshness, so stamp the final context
    // length (the last assistant usage in the snapshot) on all entries.
    if (contextL !== undefined) {
      for (const view of views) view.contextL = contextL
    }
    return views
  }
}

/**
 * One-shot fold of a node list (stateless). The live dashboard should use
 * {@link MountFold}, which persists across the paginated history window.
 * Foreign or malformed nodes are skipped; a hash change replaces the entry
 * wholesale (the old mount is stale), same-hash messages union their ranges.
 */

export function foldMounts(nodes: readonly ConversationNode[]): MountedFileView[] {
  return new MountFold().fold('', nodes)
}