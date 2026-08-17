/**
 * Mount ledger vocabulary. The ledger's durable carrier is the SOURCE of the
 * plugin-injected context message (a standard `user/message` event — known to
 * every DSH build, so persisted sessions always load). Custom session event
 * types are NOT used: rc.6's `Session.append` cannot mark an event
 * `ignorable`, and the persistence read path hard-refuses unknown types
 * (verified against the compiled coordinator). Revisit when DSH opens a
 * registration surface for out-of-repo event types.
 */

/** Mounted content segment: 1-based inclusive line range. */
export interface Segment {
  start: number
  end: number
}

/**
 * Freshness metadata for one mounted segment (attention-decay plan). `born` is
 * the context position (input tokens) where the segment was mounted; `expired`
 * counts how many times this content expired and was re-read (history kept
 * across expiry so the UI can show the count).
 */
export interface SegmentMeta {
  /** Context position (input tokens) at mount time; undefined when unknown
   * (pre-freshness messages or no usage data on the session). */
  born?: number
  /** Estimated token count of this segment (midpoint size in the freshness score); undefined for legacy/unknown. */
  tokens?: number
  /** Times this content expired and was re-read; never resets. */
  expired: number
}

/** One ledger segment: geometry + freshness metadata (the ledger's working unit). */
export interface LedgerSegment extends Segment, SegmentMeta {}

/** One expired segment kept as history (geometry + count, no born). */
export interface ExpiredSegment {
  start: number
  end: number
  expired: number
}

/** How a mount extended the ledger (observability and fold semantics). */
export type MountKind = 'new' | 'increment' | 'remount' | 'dedup'

/** Per-file mounted state kept in memory and folded from injected messages. */
export interface MountedFile {
  /** Normalized absolute path (identity key). */
  absPath: string
  /** sha256 hex of the bytes the segments were read from. */
  hash: string
  /** Line count of the file at hash time. */
  totalLines: number
  /** Mounted ranges, normalized ascending, each carrying freshness metadata. */
  segments: LedgerSegment[]
  /** Expired segments retained as history so a re-mount inherits the count. */
  expiredHistory: ExpiredSegment[]
  /** Cumulative tokens this ledger kept out of the context for this path. */
  savedTokens: number
  /** Cumulative tokens the plugin's own injected notes cost for this path. */
  spentTokens: number
}

/**
 * Structured mount state carried on the injected message's source
 * (merge-extensible JSON; the model-visible content mirrors it).
 */
export interface MountSource {
  kind: 'plugin'
  plugin: 'file-mount'
  /** Producer-declared presentation: a collapsed row shows the summary. */
  form: 'notice'
  /** One-line account of this mount (row summary and trajectory preview). */
  summary: string
  /** Normalized absolute path (ledger identity). */
  path: string
  /** sha256 hex of the file content this mount was read from. */
  hash: string
  /** Line count of the file at hash time. */
  totalLines: number
  /** Ledger ranges AFTER this mount lands (normalized ascending, with freshness metadata). */
  mounted: LedgerSegment[]
  /** Ranges this message actually adds (normalized, in-window). */
  added: Segment[]
  /** How the ledger changed: fresh anchor, union, hash-change remount, or dedup. */
  mountKind: MountKind
  /** Tokens this decision kept out of the context (0 for new/remount). */
  savedTokens: number
  /** Tokens this message's own note cost (the plugin overhead it injects). */
  spentTokens: number
  /** Freshness expiry threshold the host configured (for the browser fold). */
  freshnessThreshold?: number
}