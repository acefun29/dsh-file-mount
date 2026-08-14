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

/** How a mount extended the ledger (observability and fold semantics). */
export type MountKind = 'new' | 'increment' | 'remount'

/** Per-file mounted state kept in memory and folded from injected messages. */
export interface MountedFile {
  /** Normalized absolute path (identity key). */
  absPath: string
  /** sha256 hex of the bytes the segments were read from. */
  hash: string
  /** Line count of the file at hash time. */
  totalLines: number
  /** Mounted ranges, normalized ascending. */
  segments: Segment[]
}

/**
 * Structured mount state carried on the injected message's source
 * (merge-extensible JSON; the model-visible content mirrors it).
 */
export interface MountSource {
  kind: 'plugin'
  plugin: 'file-mount'
  /** Normalized absolute path (ledger identity). */
  path: string
  /** sha256 hex of the file content this mount was read from. */
  hash: string
  /** Line count of the file at hash time. */
  totalLines: number
  /** Ledger ranges AFTER this mount lands (normalized ascending). */
  mounted: Segment[]
  /** Ranges this message actually adds (normalized, in-window). */
  added: Segment[]
  /** How the ledger changed: fresh anchor, union, or hash-change remount. */
  mountKind: MountKind
}