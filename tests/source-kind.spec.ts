/**
 * Message source kind: the plugin writes its own producer kind `file-mount`
 * (session format v4 refuses the retired `kind: 'plugin'` wrapper), and reads
 * every persisted spelling: its own kind, the `plugin:file-mount` kind that
 * DSH's v3 to v4 migration produces, and the raw v3 wrapper.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FILE_MOUNT_SOURCE_KIND, isFileMountSource, parseMountSource } from '../src/mount-source.ts'
import { hashBuffer } from '../src/hash.ts'
import { normalizeAbsPath } from '../src/paths.ts'
import { harness, MockAdapter, textResponse, toolCallResponse, toolResultText, waitForIdle } from './harness.ts'

const PAYLOAD = {
  form: 'notice',
  summary: 'mounted L1-2',
  path: '/w/a.ts',
  hash: 'h1',
  totalLines: 10,
  mounted: [{ start: 1, end: 2, expired: 0 }],
  added: [{ start: 1, end: 2 }],
  mountKind: 'new',
  savedTokens: 0,
  spentTokens: 3,
}

/** The three persisted spellings of a file-mount source. */
const SPELLINGS: [string, Record<string, unknown>][] = [
  ['own kind (DSH 0.1.7 writer)', { kind: 'file-mount' }],
  ['v3 log migrated to v4', { kind: 'plugin:file-mount' }],
  ['raw v3 wrapper', { kind: 'plugin', plugin: 'file-mount' }],
]

describe('isFileMountSource', () => {
  it.each(SPELLINGS)('recognizes the %s', (_label, identity) => {
    expect(isFileMountSource({ ...identity, ...PAYLOAD })).toBe(true)
  })

  it('rejects foreign and malformed sources', () => {
    expect(isFileMountSource({ kind: 'user' })).toBe(false)
    expect(isFileMountSource({ kind: 'plugin', plugin: 'other' })).toBe(false)
    expect(isFileMountSource({ kind: 'plugin:other' })).toBe(false)
    expect(isFileMountSource({ kind: 'plugin' })).toBe(false)
    expect(isFileMountSource({ kind: 'compact-checkpoint' })).toBe(false)
    expect(isFileMountSource({ plugin: 'file-mount' })).toBe(false)
    expect(isFileMountSource(null)).toBe(false)
    expect(isFileMountSource('file-mount')).toBe(false)
  })
})

describe('parseMountSource', () => {
  it.each(SPELLINGS)('folds the %s into the same delta', (_label, identity) => {
    const parsed = parseMountSource({ ...identity, ...PAYLOAD })
    expect(parsed).toEqual({
      path: '/w/a.ts',
      mountKind: 'new',
      delta: { hash: 'h1', totalLines: 10, segments: [{ start: 1, end: 2, expired: 0 }], savedTokens: 0, spentTokens: 3 },
    })
  })

  it('ignores a foreign kind carrying a valid mount payload', () => {
    expect(parseMountSource({ kind: 'plugin:other', ...PAYLOAD })).toBeUndefined()
  })
})

describe('written source', () => {
  let dir: string
  let file: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-kind-'))
    file = join(dir, 'a.txt')
    await writeFile(file, Array.from({ length: 6 }, (_, i) => `${i + 1}${'x'.repeat(39)}`).join('\n') + '\n', 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('writes the producer kind file-mount without the retired plugin field', async () => {
    const ctx = await harness(new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file }),
      textResponse('done'),
    ]), { cwd: dir, config: { minSavedTokens: 0 } })
    const agent = await ctx.agentLoop.create(SessionId('kind-written'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const sources = agent.session.snapshotEvents()
      .filter((event) => event.type === 'user/message')
      .map((event) => event.data.source as unknown as Record<string, unknown>)
      .filter(isFileMountSource)
    expect(sources).toHaveLength(1)
    expect(FILE_MOUNT_SOURCE_KIND).toBe('file-mount')
    expect(sources[0]!['kind']).toBe('file-mount')
    expect(Object.hasOwn(sources[0]!, 'plugin')).toBe(false)
    expect(sources[0]!['form']).toBe('notice')
    expect(typeof sources[0]!['summary']).toBe('string')
    await ctx.fiber.dispose()
  })

  it.each(SPELLINGS)('replays a %s mount from the live log, so the next read dedupes', async (label, identity) => {
    const ctx = await harness(new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('done'),
    ]), { cwd: dir, config: { minSavedTokens: 0 } })
    const agent = await ctx.agentLoop.create(SessionId(`kind-replay-${SPELLINGS.findIndex(([l]) => l === label)}`), { provider: 'mock', model: 'mock' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[file-mount: seed]' }],
      source: {
        ...identity,
        form: 'notice',
        summary: 'seed',
        path: normalizeAbsPath(file),
        hash: hashBuffer(await readFile(file)),
        totalLines: 6,
        mounted: [{ start: 1, end: 2 }],
        added: [{ start: 1, end: 2 }],
        mountKind: 'new',
      } as never,
    }), { surfaceOp: 'append' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(toolResultText(agent, 'c1')).toContain('already mounted, not re-added')
    await ctx.fiber.dispose()
  })
})
