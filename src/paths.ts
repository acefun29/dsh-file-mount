import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Cached case-insensitivity probe result (null = not probed yet). */
let caseInsensitive: boolean | null = null

/**
 * Probe the local filesystem once: does the same path exist under a different
 * letter case? Windows and default macOS filesystems are case-insensitive;
 * Linux and explicitly case-sensitive macOS are not.
 */
function detectCaseInsensitive(): boolean {
  try {
    const probe = join(tmpdir(), `dsh-fm-probe-${process.pid}-${Date.now()}`)
    writeFileSync(probe, 'x', 'utf8')
    const exists = existsSync(probe.toUpperCase())
    rmSync(probe, { force: true })
    return exists
  } catch {
    return process.platform === 'win32'
  }
}

function isCaseInsensitive(): boolean {
  if (caseInsensitive === null) caseInsensitive = detectCaseInsensitive()
  return caseInsensitive
}

/**
 * Canonical identity for mounted files: absolute, symlink-resolved (a soft
 * link unifies to its real file), and case-folded on case-insensitive
 * filesystems so `SRC/Foo.TS` and `src/foo.ts` share one ledger entry
 * (plan item 22).
 */
export function normalizeAbsPath(absPath: string): string {
  let resolved: string
  try {
    resolved = realpathSync(resolve(absPath))
  } catch {
    resolved = resolve(absPath)
  }
  return isCaseInsensitive() ? resolved.toLowerCase() : resolved
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function foldPath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * Model-facing path for marker heads: relative to `cwd` with forward slashes
 * when the file is inside the workspace. Files outside `cwd` (or when `cwd`
 * is missing) stay absolute, also posix-ified. Ledger identity stays on
 * {@link normalizeAbsPath}.
 */
export function displayPath(filePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return toPosix(filePath)
  const abs = resolve(cwd, filePath)
  const base = resolve(cwd)
  const rel = relative(foldPath(base), foldPath(abs))
  if (rel === '') return '.'
  const relPosix = toPosix(rel)
  if (isAbsolute(rel) || relPosix === '..' || relPosix.startsWith('../')) return toPosix(abs)
  const prefixLen = base.length + (abs.length > base.length ? 1 : 0)
  if (prefixLen > abs.length) return toPosix(abs)
  return toPosix(abs.slice(prefixLen))
}
