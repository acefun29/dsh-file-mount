/**
 * Degradation contract for the message source (Issue #2).
 *
 * DSH's session-format migration validates the members of a plugin message
 * source; an unexpected member can make it refuse a whole session log (a
 * delayed failure that only surfaces on a later format bump). The plugin
 * therefore writes only members it must keep durable:
 *
 * - identity + ledger geometry: kind/form/summary/path/hash/totalLines/
 *   mounted(added)/mountKind,
 * - the two counters the fold needs for totals: savedTokens/spentTokens
 *   (spentTokens is the per-message overhead record; it cannot be rebuilt
 *   from the log alone, so it stays a legitimate accounting member).
 *
 * The retired display-only member `freshnessThreshold` is no longer written.
 * These tests pin the consequence: a log written with the reduced member set
 * dedupes, increments and replays exactly like one carrying the old extras,
 * and every historical spelling keeps parsing.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseMountSource } from '../src/mount-source.ts'
import { MountStore } from '../src/store.ts'
import { hashBuffer } from '../src/hash.ts'
import { normalizeAbsPath } from '../src/paths.ts'
import { harness, MockAdapter, textResponse, toolCallResponse, toolResultText, waitForIdle } from './harness.ts'

/** The members the plugin writes today (post-slimming). */
const LEAN = {
  kind: 'file-mount',
  form: 'notice',
  summary: 'mounted L1-2',
  path: '/w/a.ts',
  hash: 'h1',
  totalLines: 10,
  mounted: [{ start: 1, end: 2, expired: 0 }],
  added: [{ start: 1, end: 2 }],
  mountKind: 'new',
  savedTokens: 0,
}

/** What 0.8.0 and earlier additionally wrote. */
const LEGACY_EXTRAS = {
  spentTokens: 3,
  freshnessThreshold: 0.6,
}

describe('source slimming contract', () => {
  it('parses a lean (current) source and a legacy extra-carrying source to the same delta', () => {
    const lean = parseMountSource({ ...LEAN })
    const legacy = parseMountSource({ ...LEAN, ...LEGACY_EXTRAS })
    expect(lean).toBeDefined()
    // Everything except the spent counter — the one member whose absence is
    // allowed to read as 0 — must fold identically.
    expect({ ...lean!.delta, spentTokens: 0 }).toEqual({ ...legacy!.delta, spentTokens: 0 })
    expect(lean!.delta.spentTokens).toBe(0)
    expect(legacy!.delta.spentTokens).toBe(3)
    expect(lean!.path).toBe(legacy!.path)
    expect(lean!.mountKind).toBe(legacy!.mountKind)
  })

  it('keeps the required members strict: dropping identity or geometry loses the record', () => {
    // One representative per class; the exhaustive per-member table lives in
    // tests/store.spec.ts.
    expect(parseMountSource({ ...LEAN, path: '' })).toBeUndefined()
    expect(parseMountSource({ ...LEAN, mounted: [] })).toBeUndefined()
  })

  it('replay folds a lean log into the same ledger as an extra-carrying one', () => {
    const leanStore = new MountStore()
    leanStore.replay([{ type: 'user/message', source: { ...LEAN } }])
    const legacyStore = new MountStore()
    legacyStore.replay([{ type: 'user/message', source: { ...LEAN, ...LEGACY_EXTRAS } }])
    const leanFile = leanStore.get('/w/a.ts')
    const legacyFile = legacyStore.get('/w/a.ts')
    expect(leanFile).toBeDefined()
    expect(leanFile!.segments).toEqual(legacyFile!.segments)
    expect(leanFile!.hash).toBe(legacyFile!.hash)
    expect(leanFile!.totalLines).toBe(legacyFile!.totalLines)
  })
})

describe('lean source end to end', () => {
  let dir: string
  let file: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-degrade-'))
    file = join(dir, 'a.txt')
    await writeFile(file, Array.from({ length: 6 }, (_, i) => `${i + 1}${'x'.repeat(39)}`).join('\n') + '\n', 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('dedupes the next read from a lean seed carrying no extras', async () => {
    const ctx = await harness(new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('done'),
    ]), { cwd: dir, config: { minSavedTokens: 0 } })
    const agent = await ctx.agentLoop.create(SessionId('degrade-lean-dedup'), { provider: 'mock', model: 'mock' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[file-mount: seed]' }],
      source: {
        kind: 'file-mount',
        form: 'notice',
        summary: 'seed',
        path: normalizeAbsPath(file),
        hash: hashBuffer(await readFile(file)),
        totalLines: 6,
        mounted: [{ start: 1, end: 2 }],
        added: [{ start: 1, end: 2 }],
        mountKind: 'new',
        // No spentTokens, no freshnessThreshold: the caller is the source of truth,
        // and the fold must still recognize full coverage.
      } as never,
    }), { surfaceOp: 'append' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(toolResultText(agent, 'c1')).toContain('already mounted, not re-added')
    await ctx.fiber.dispose()
  })
})
