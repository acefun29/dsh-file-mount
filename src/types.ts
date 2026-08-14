/**
 * Mount ledger vocabulary (ported from piwpi's context-mount types.ts, trimmed
 * to v1). The session event augmentation makes the durable `file-mount/*`
 * events type-check at `session.append` call sites; the events carry the
 * `ignorable` marker because out-of-repo plugin types never enter DSH's
 * generated KNOWN_SESSION_EVENT_TYPES (see the plan doc, design idea 5).
 */
import type {} from '@deepseek-ai/dsh-session/types'

/** Mounted content segment: 1-based inclusive line range. */
export interface Segment {
  start: number
  end: number
}

/** How a mount extended the ledger (observability only; replay unions ranges). */
export type MountKind = 'new' | 'increment' | 'remount'

/** Per-file mounted state kept in memory and folded from durable events. */
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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One read window (or part of it) joined the mount ledger. */
    'file-mount/mounted': {
      path: string
      hash: string
      totalLines: number
      segment: Segment
      kind: MountKind
    }
    /** A hash mismatch dropped the previous mount for a path. */
    'file-mount/invalidated': {
      path: string
      oldHash: string
      newHash: string
    }
  }
}
