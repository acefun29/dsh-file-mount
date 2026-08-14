import { resolve } from 'node:path'

/**
 * Canonical identity for mounted files: absolute, and case-folded on
 * case-insensitive platforms so `SRC\Foo.TS` and `src\foo.ts` share one
 * ledger entry.
 */
export function normalizeAbsPath(absPath: string): string {
  const resolved = resolve(absPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
