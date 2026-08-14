import { createHash } from 'node:crypto'

/**
 * Full-file identity (ported from piwpi's hash.ts). Hash the RAW BYTES, not
 * the UTF-8 string, so CRLF/encoding normalization cannot make two different
 * on-disk contents collide.
 */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Per-line fingerprint length: first 16 bytes of sha256 (32 hex chars). */
const LINE_FINGERPRINT_BYTES = 16

/** Short fingerprint of one line's bytes (collision-resistant enough for diffing). */
function lineFingerprint(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex').slice(0, LINE_FINGERPRINT_BYTES * 2)
}

/**
 * Split raw bytes into lines exactly the way the read tool numbers them, then
 * fingerprint each line. The split mirrors dsh-tool-fs's window scanner:
 * UTF-8 decode, split on a newline, strip a trailing carriage return per line
 * (CRLF), and drop the empty segment a trailing newline leaves behind (so a
 * trailing newline does not add an extra line, and an empty file has zero).
 * Index 0 of the result is line 1.
 *
 * This is the "draft" (底稿) item 9 diffs against: fingerprints only, never
 * the full text, so a draft stays dozens of times smaller than its file.
 */
export function fingerprintLines(buf: Buffer): string[] {
  const parts = buf.toString('utf8').split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => lineFingerprint(line.endsWith('\r') ? line.slice(0, -1) : line))
}
