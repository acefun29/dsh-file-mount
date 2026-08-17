import { describe, expect, it } from 'vitest'
import {
  formatRange,
  markerHead,
  renderDedupMarker,
  renderMountBlock,
  renderRemountMarker,
} from '../src/render.ts'

describe('formatRange', () => {
  it('renders a single line without a dash', () => {
    expect(formatRange(20, 20)).toBe('L20')
  })

  it('renders a span with a dash', () => {
    expect(formatRange(20, 80)).toBe('L20-80')
  })
})

describe('markerHead', () => {
  it('normalizes and sorts mounted ranges', () => {
    const head = markerHead('src/auth.ts', '9f3a2c1e9f3a2c1e', [
      { start: 50, end: 80 },
      { start: 20, end: 40 },
    ])
    expect(head).toBe('[file-mount: src/auth.ts hash:9f3a2c1e mounted:L20-40, L50-80]')
  })

  it('shortens the hash to 8 chars', () => {
    expect(markerHead('a.ts', 'abcdef0123456789', [{ start: 1, end: 1 }]))
      .toBe('[file-mount: a.ts hash:abcdef01 mounted:L1]')
  })

  it('renders deterministically for identical state', () => {
    const segments = [{ start: 1, end: 100 }, { start: 150, end: 200 }]
    expect(markerHead('x.ts', 'h', segments)).toBe(markerHead('x.ts', 'h', segments))
  })

  it('collapses many ranges into a line/range count', () => {
    const mounted = [
      { start: 1, end: 10 },
      { start: 21, end: 30 },
      { start: 41, end: 50 },
      { start: 61, end: 70 },
    ]
    expect(markerHead('src/a.ts', 'abc12345', mounted))
      .toBe('[file-mount: src/a.ts hash:abc12345 mounted:40 lines in 4 ranges]')
  })
})

describe('renderDedupMarker', () => {
  it('states that nothing was re-added and how to recover if the content is missing', () => {
    expect(renderDedupMarker('src/a.ts', 'abc12345', [{ start: 20, end: 80 }]))
      .toBe('[file-mount: src/a.ts hash:abc12345 mounted:L20-80] - already mounted, not re-added. If this content is not in the conversation above, call file_mount_forget then read the file again.')
  })
})

describe('renderRemountMarker', () => {
  it('states the file changed', () => {
    expect(renderRemountMarker('src/a.ts', 'abc12345', [{ start: 1, end: 10 }]))
      .toBe('[file-mount: src/a.ts hash:abc12345 mounted:L1-10] - file changed since last mount, remounting')
  })

  it('reports the diff shape when stats are supplied', () => {
    expect(renderRemountMarker('src/a.ts', 'abc12345', [{ start: 1, end: 10 }], { added: 1, removed: 1, unchanged: 9 }))
      .toBe('[file-mount: src/a.ts hash:abc12345 mounted:L1-10] - file changed: +1/-1 lines (~9 unchanged) since last mount')
  })
})

describe('renderMountBlock', () => {
  it('renders one missing range with its header and body', () => {
    const text = renderMountBlock({
      path: 'src/a.ts',
      hash: 'abc123456789',
      mounted: [{ start: 1, end: 55 }],
      windowStart: 50,
      lines: ['50', '51', '52', '53', '54', '55', '56', '57', '58', '59', '60'],
      missing: [{ start: 52, end: 55 }],
    })
    expect(text).toBe(
      '[file-mount: src/a.ts hash:abc12345 mounted:L1-55]\n--- L52-55 ---\n52: 52\n53: 53\n54: 54\n55: 55',
    )
  })

  it('renders each missing range with its own header', () => {
    const text = renderMountBlock({
      path: 'src/a.ts',
      hash: 'h',
      mounted: [{ start: 1, end: 9 }],
      windowStart: 1,
      lines: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
      missing: [{ start: 2, end: 3 }, { start: 6, end: 7 }],
    })
    expect(text).toBe(
      '[file-mount: src/a.ts hash:h mounted:L1-9]\n--- L2-3 ---\n2: 2\n3: 3\n--- L6-7 ---\n6: 6\n7: 7',
    )
  })

  it('merges adjacent missing ranges', () => {
    const text = renderMountBlock({
      path: 'src/a.ts',
      hash: 'h',
      mounted: [{ start: 1, end: 10 }],
      windowStart: 1,
      lines: ['1', '2', '3'],
      missing: [{ start: 1, end: 2 }, { start: 3, end: 3 }],
    })
    expect(text).toBe('[file-mount: src/a.ts hash:h mounted:L1-10]\n--- L1-3 ---\n1: 1\n2: 2\n3: 3')
  })
})
