/**
 * Minimal glob matching for the exclude list (plan item 7). Supports `*`
 * (within one path segment), `**` (across segments), and `?` (one char).
 * Patterns are matched against the forward-slash-normalized absolute path.
 */

function escapeRegexChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Convert one glob pattern to an anchored RegExp (forward-slash paths). */
export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += escapeRegexChar(char)
    }
  }
  return new RegExp(out + '$')
}

/**
 * True when `absPath` matches any glob in the list. Path separators are
 * normalized to forward slashes so a node_modules pattern works on Windows too.
 */
export function matchesAnyGlob(absPath: string, globs: readonly string[]): boolean {
  const normalized = absPath.replace(/\\/g, '/')
  return globs.some((pattern) => globToRegExp(pattern).test(normalized))
}
