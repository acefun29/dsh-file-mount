import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { displayPath, normalizeAbsPath } from '../src/paths.ts'

describe('normalizeAbsPath', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-fm-path-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('case-folds on case-insensitive platforms (plan item 22)', () => {
    const normalized = normalizeAbsPath(join(dir, 'MiXeD.Ts'))
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(normalized).toBe(normalized.toLowerCase())
    } else {
      expect(normalized).toBe(join(dir, 'MiXeD.Ts'))
    }
  })

  it('resolves a symlink to the real file (plan item 22)', async () => {
    const real = join(dir, 'real.txt')
    const link = join(dir, 'link.txt')
    await writeFile(real, 'x', 'utf8')
    try {
      await symlink(real, link)
    } catch {
      return // symlinks may need privileges on Windows; skip
    }
    expect(normalizeAbsPath(link)).toBe(normalizeAbsPath(real))
  })

  it('falls back to resolve for paths that do not exist', () => {
    const missing = join(dir, 'nope', '..', 'Missing.TS')
    expect(normalizeAbsPath(missing)).toContain('missing.ts'.toLowerCase() === 'missing.ts' ? 'missing' : 'MISSING')
  })
})

describe('displayPath', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-fm-disp-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns a posix-relative path when the file is inside cwd', () => {
    expect(displayPath(join(dir, 'pkg', 'inner.ts'), dir)).toBe('pkg/inner.ts')
  })

  it('returns just the basename for a file in cwd', () => {
    expect(displayPath(join(dir, 'foo.txt'), dir)).toBe('foo.txt')
  })

  it('keeps an already-relative path', () => {
    expect(displayPath('src/auth.ts', dir)).toBe('src/auth.ts')
  })

  it('keeps an absolute path when the file is outside cwd', () => {
    const outside = join(tmpdir(), 'dsh-fm-other', 'x.ts')
    const shown = displayPath(outside, dir)
    expect(shown).not.toMatch(/^\.\./)
    expect(shown.includes('\\')).toBe(false)
    expect(shown.endsWith('/x.ts') || shown.endsWith('x.ts')).toBe(true)
  })

  it('posix-ifies the input when cwd is missing', () => {
    expect(displayPath('e:\\proj\\a.ts', undefined)).toBe('e:/proj/a.ts')
  })
})
