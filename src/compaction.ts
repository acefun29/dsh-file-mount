/**
 * Compaction awareness for the mount ledger (duck-typed against DSH's
 * canonical checkpoint shape, so the plugin needs no dsh-compaction peer).
 *
 * DSH compacts a session at the SURFACE layer: one `user/message` checkpoint
 * (canonical source `{ kind: 'plugin', plugin: 'compact' }`) replaces the
 * shadowed range, and its event-level `sourceEventSeqs` lists every shadowed
 * event. Shadowed events stay in the raw log, so a ledger that folds the log
 * must skip them: a mount claim from a shadowed message no longer holds,
 * because the model context no longer contains that content. Deduping against
 * a shadowed claim would silently deny the model content it no longer has.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * True when an event is the canonical compaction checkpoint: a
 * `user/message` whose source is the plugin 'compact' marker.
 */
export function isCompactCheckpoint(event: unknown): boolean {
  if (!isRecord(event)) return false
  if (event['type'] !== 'user/message') return false
  const data = event['data']
  if (!isRecord(data)) return false
  const source = data['source']
  return isRecord(source) && source['kind'] === 'plugin' && source['plugin'] === 'compact'
}

/**
 * Seq numbers of every event shadowed by a compact checkpoint in the log
 * (union over all checkpoints). Malformed lists and non-integer entries are
 * skipped defensively.
 */
export function shadowedSeqsOf(events: readonly unknown[]): Set<number> {
  const shadowed = new Set<number>()
  for (const event of events) {
    if (!isCompactCheckpoint(event)) continue
    const seqs = (event as Record<string, unknown>)['sourceEventSeqs']
    if (!Array.isArray(seqs)) continue
    for (const seq of seqs) {
      if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) shadowed.add(seq)
    }
  }
  return shadowed
}
