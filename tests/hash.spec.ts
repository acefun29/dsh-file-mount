/**
 * Line-fingerprint unit tests: the draft must mirror the read tool's line
 * numbering (split on \n, strip one trailing \r, drop the trailing-newline
 * empty segment, strip a leading BOM — TextDecoder does, buf.toString does
 * not), and fingerprints must be stable, fixed-width and content-sensitive.
 */
import { describe, expect, it } from 'vitest'
import { fingerprintLines, fingerprintText, hashBuffer } from '../src/hash.ts'

describe('fingerprintLines', () => {
  it('splits on \\n and drops the trailing-newline empty segment', () => {
    expect(fingerprintLines(Buffer.from('a\nb\n', 'utf8'))).toHaveLength(2)
    expect(fingerprintLines(Buffer.from('a\nb', 'utf8'))).toHaveLength(2)
    expect(fingerprintLines(Buffer.from('a\nb\n', 'utf8')))
      .toEqual(fingerprintLines(Buffer.from('a\nb', 'utf8')))
  })

  it('keeps interior empty lines and treats an empty file as zero lines', () => {
    expect(fingerprintLines(Buffer.from('', 'utf8'))).toEqual([])
    expect(fingerprintLines(Buffer.from('a\n\n', 'utf8'))).toHaveLength(2)
    expect(fingerprintLines(Buffer.from('a\n\n\n', 'utf8'))).toHaveLength(3)
  })

  it('strips one trailing \\r per line (CRLF equals LF)', () => {
    expect(fingerprintLines(Buffer.from('a\r\nb\r\n', 'utf8')))
      .toEqual(fingerprintLines(Buffer.from('a\nb\n', 'utf8')))
  })

  it('strips a leading UTF-8 BOM, matching the read tool (TextDecoder)', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n', 'utf8')])
    expect(fingerprintLines(withBom)).toEqual(fingerprintLines(Buffer.from('a\nb\n', 'utf8')))
  })

  it('does NOT strip the BOM from the whole-file identity hash', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n', 'utf8')])
    expect(hashBuffer(withBom)).not.toBe(hashBuffer(Buffer.from('a\n', 'utf8')))
  })

  it('produces stable fixed-width fingerprints that react to content', () => {
    const fps = fingerprintLines(Buffer.from('hello\nworld\n', 'utf8'))
    expect(fps).toHaveLength(2)
    for (const fp of fps) expect(fp).toMatch(/^[0-9a-f]{14}$/)
    expect(fingerprintLines(Buffer.from('hello\nworld\n', 'utf8'))).toEqual(fps)
    expect(fingerprintLines(Buffer.from('hello\nworld!\n', 'utf8'))[1]).not.toBe(fps[1])
  })
})

describe('fingerprintText', () => {
  it('agrees with fingerprintLines on the same content', () => {
    const text = 'alpha\nbeta\n\ngamma\n'
    expect(fingerprintText(text)).toEqual(fingerprintLines(Buffer.from(text, 'utf8')))
  })

  it('strips a leading U+FEFF (the write tool value side of a BOM file)', () => {
    expect(fingerprintText('\uFEFFa\nb\n')).toEqual(fingerprintText('a\nb\n'))
  })

  it('folds CRLF the same way the write tool value does', () => {
    expect(fingerprintText('a\r\nb\r\n')).toEqual(fingerprintText('a\nb\n'))
  })
})
