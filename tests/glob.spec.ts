import { describe, expect, it } from 'vitest'
import { matchesAnyGlob } from '../src/glob.ts'

describe('matchesAnyGlob', () => {
  it('matches a node_modules pattern anywhere (both separators)', () => {
    expect(matchesAnyGlob('C:/proj/node_modules/x/y.ts', ['**/node_modules/**'])).toBe(true)
    expect(matchesAnyGlob('C:\\proj\\node_modules\\x\\y.ts', ['**/node_modules/**'])).toBe(true)
    expect(matchesAnyGlob('C:/proj/src/a.ts', ['**/node_modules/**'])).toBe(false)
  })

  it('single-star stays within one path segment', () => {
    expect(matchesAnyGlob('/tmp/build/out.js', ['**/build/*.js'])).toBe(true)
    expect(matchesAnyGlob('/tmp/build/sub/out.js', ['**/build/*.js'])).toBe(false)
  })

  it('matches ? as exactly one character', () => {
    expect(matchesAnyGlob('/a/b1.ts', ['/a/b?.ts'])).toBe(true)
    expect(matchesAnyGlob('/a/b12.ts', ['/a/b?.ts'])).toBe(false)
  })

  it('escapes regex metacharacters in literals', () => {
    expect(matchesAnyGlob('/a/file(v1).ts', ['/a/file(v1).ts'])).toBe(true)
    expect(matchesAnyGlob('/a/file(v2).ts', ['/a/file(v1).ts'])).toBe(false)
  })

  it('an empty glob list matches nothing', () => {
    expect(matchesAnyGlob('/a/b.ts', [])).toBe(false)
  })
})
