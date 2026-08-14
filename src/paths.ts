import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
