import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, basename, dirname, join, relative, resolve } from 'node:path'

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
 *
 * Inside/outside is decided on realpath identity, not raw spelling: the read
 * tool reports realpath'd paths while a caller may pass a symlinked cwd
 * (macOS `/var` vs `/private/var`), and a raw prefix comparison would then
 * misfile workspace files as outside. A missing path falls back to its
 * physical spelling; relative tails are identical under both spellings.
 */
export function displayPath(filePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return toPosix(filePath)
  const abs = resolve(cwd, filePath)
  const base = realOrRaw(resolve(cwd))
  const physical = realOrRaw(abs)
  const rel = relative(foldPath(base), foldPath(physical))
  if (rel === '') return '.'
  const relPosix = toPosix(rel)
  if (isAbsolute(relPosix) || relPosix === '..' || relPosix.startsWith('../')) return toPosix(abs)
  return toPosix(physical.slice(base.length + 1))
}

/** Symlink-resolved spelling of a path. For a missing target, resolve the
 * nearest existing ancestor and re-append the missing suffix, so both sides
 * of the comparison share one physical spelling before and after creation
 * (same approach as fs-local's resolveLocalTarget). */
function realOrRaw(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    /* fall through to ancestor walk */
  }
  const missing: string[] = []
  let ancestor = p
  while (true) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return p
    missing.unshift(basename(ancestor))
    ancestor = parent
    try {
      return join(realpathSync(ancestor), ...missing)
    } catch {
      /* keep walking up */
    }
  }
}
