import { createHash } from 'node:crypto'

/**
 * Full-file identity (ported from piwpi's hash.ts). Hash the RAW BYTES, not
 * the UTF-8 string, so CRLF/encoding normalization cannot make two different
 * on-disk contents collide.
 */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 53-bit fingerprint of one line (cyrb53). Non-cryptographic by design: line
 * fingerprints are diff anchors only — computed and compared in memory, never
 * persisted, never sent over the wire — so the collision budget that matters
 * is the birthday bound over one file's line count (≈5e-2 expected collisions
 * on a 1M-line file pair), and a rare collision reads as "line unchanged",
 * the same failure mode a truncated sha256 had. Roughly an order of magnitude
 * cheaper than one createHash call per line and under half the memory
 * (14 vs 32 hex chars).
 */
function lineFingerprint(line: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/**
 * Split text into lines exactly the way the read tool numbers them (mirrors
 * dsh-tool-fs's window scanner: split on \n, strip one trailing \r per line
 * (CRLF), and drop the empty segment a trailing newline leaves behind — so a
 * trailing newline adds no extra line and an empty text has zero lines), then
 * fingerprint each line. A leading U+FEFF is stripped first because the read
 * tool's TextDecoder strips a BOM. Index 0 of the result is line 1.
 */
export function fingerprintText(text: string): string[] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const parts = stripped.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => lineFingerprint(line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * Split raw bytes into lines exactly the way the read tool numbers them, then
 * fingerprint each line. The decode mirrors dsh-tool-fs: UTF-8 with a leading
 * BOM (EF BB BF) stripped — TextDecoder strips it, Node's buf.toString does
 * not, and an unstripped BOM would make line 1's fingerprint permanently
 * mismatch the read tool's line 1 (every diff would re-send it).
 *
 * This is the "draft" (底稿) item 9 diffs against: fingerprints only, never
 * the full text, so a draft stays dozens of times smaller than its file.
 */
export function fingerprintLines(buf: Buffer): string[] {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return fingerprintText((hasBom ? buf.subarray(3) : buf).toString('utf8'))
}
