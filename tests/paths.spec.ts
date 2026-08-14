import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeAbsPath } from '../src/paths.ts'

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
