/**
 * Deterministic model-facing rendering (ported from piwpi's render.ts). The
 * same ledger state renders byte-identically, which keeps the provider prompt
 * prefix cache stable across requests. All text is model-facing English,
 * matching the harness's own tool-output convention (UI strings are localized
 * separately in the client half).
 *
 * Formats:
 *   head    [file-mount: <path> hash:<h8> mounted:L20-80]
 *   dedup   head + note (zero content re-added)
 *   block   head + per-segment "--- Ls-e ---" headers + raw lines
 */
import { normalize } from './ranges.ts'
import type { Segment } from './types.ts'

export function formatRange(start: number, end: number): string {
  return start === end ? `L${start}` : `L${start}-${end}`
}

/**
 * Shared marker head: identity + short hash + a compact mounted summary.
 * A few ranges are listed outright; many ranges collapse to a line/range
 * count so the note never grows with the number of mounted ranges (item 12).
 */
export function markerHead(path: string, hash: string, mounted: Segment[]): string {
  const normalized = normalize(mounted)
  let summary: string
  if (normalized.length === 0) {
    summary = 'none'
  } else if (normalized.length <= 3) {
    summary = normalized.map((s) => formatRange(s.start, s.end)).join(', ')
  } else {
    const lineCount = normalized.reduce((n, s) => n + (s.end - s.start + 1), 0)
    summary = `${lineCount} lines in ${normalized.length} ranges`
  }
  return `[file-mount: ${path} hash:${hash.slice(0, 8)} mounted:${summary}]`
}

/** Full-coverage read: the window adds nothing new. */
export function renderDedupMarker(path: string, hash: string, mounted: Segment[]): string {
  return `${markerHead(path, hash, mounted)} - already mounted, not re-added`
}

/** Line counts a diff produced (added/removed/unchanged), for the remount note. */
export interface RemountStats {
  added: number
  removed: number
  unchanged: number
}

/** Hash change: the previous mount is stale and the window remounts. With diff
 * stats, report the change shape; otherwise the generic remount note. */
export function renderRemountMarker(path: string, hash: string, mounted: Segment[], stats?: RemountStats): string {
  const head = markerHead(path, hash, mounted)
  if (stats === undefined) return `${head} - file changed since last mount, remounting`
  return `${head} - file changed: +${stats.added}/-${stats.removed} lines (~${stats.unchanged} unchanged) since last mount`
}

/** Options for {@link renderMountBlock}. */
export interface MountBlockOptions {
  /** Mounted identity (path as shown to the model). */
  path: string
  /** Current full-file hash. */
  hash: string
  /** Ledger state AFTER this mount lands. */
  mounted: Segment[]
  /** 1-based line number of `lines[0]` in the file. */
  windowStart: number
  /** The read tool's returned window body, in order. */
  lines: string[]
  /** Ranges of `lines` that are NOT yet in the context (normalized, in-window). */
  missing: Segment[]
}

/** Render the new-content block: marker head + one header/body pair per missing range. */
export function renderMountBlock(opts: MountBlockOptions): string {
  const out = [markerHead(opts.path, opts.hash, opts.mounted)]
  for (const seg of normalize(opts.missing)) {
    out.push(`--- ${formatRange(seg.start, seg.end)} ---`)
    out.push(opts.lines.slice(seg.start - opts.windowStart, seg.end - opts.windowStart + 1).join('\n'))
  }
  return out.join('\n')
}
