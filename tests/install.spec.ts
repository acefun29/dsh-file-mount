import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isCheckout, toFileUrlSpec } from '../scripts/install-cli.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('one-click install contract', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
    files?: string[]
    bin?: Record<string, string>
    packageManager?: string
    dsh?: { bundle?: { patch?: string } }
    repository?: { url?: string }
  }

  it('ships a prebuilt bundle with no install-time prepare script', () => {
    expect(pkg.scripts?.prepare).toBeUndefined()
    expect(pkg.packageManager).toBeUndefined()
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toEqual(expect.arrayContaining([
      'lib/index.js',
      'lib/client.js',
      'cordis.patch.yml',
      'scripts/install-cli.mjs',
    ]))
    expect(pkg.bin?.['dsh-file-mount']).toBe('./scripts/install-cli.mjs')
    expect(pkg.repository?.url).toContain('dsh-file-mount')
  })

  it('builds a file: spec without backslashes so Windows keeps the drive letter', () => {
    const spec = toFileUrlSpec(join(root, 'dsh-file-mount-0.5.1.tgz'))
    expect(spec.startsWith('file:')).toBe(true)
    expect(spec.includes('\\')).toBe(false)
    expect(isCheckout(root)).toBe(true)
  })
})
