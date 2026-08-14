import { createHash } from 'node:crypto'

/**
 * Full-file identity (ported from piwpi's hash.ts). Hash the RAW BYTES, not
 * the UTF-8 string, so CRLF/encoding normalization cannot make two different
 * on-disk contents collide.
 */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
