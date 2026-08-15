/**
 * Integration coverage: the plugin composed into the real loop with the real
 * `read` tool over a temp filesystem. Scenarios: anchor + dedup + increment,
 * hash-change remount, lazy replay from the live session log, and a jsonl
 * persistence round trip (the standard user/message carrier must survive).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MountStore } from '../src/store.ts'
import { hashBuffer } from '../src/hash.ts'
import { normalizeAbsPath } from '../src/paths.ts'
import { harness, MockAdapter, textResponse, toolCallResponse, waitForIdle } from './harness.ts'

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** All file-mount injected messages in the log, in order. */
function mountMessages(agent: Agent) {
  return agent.session.events
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data.source)
    .filter((source) => typeof source === 'object' && source !== null
      && source['kind'] === 'plugin' && source['plugin'] === 'file-mount') as unknown as Record<string, unknown>[]
}

/** Geometry-only view of mounted segments (freshness meta ignored). */
function geo(segs: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  return segs.map(({ start, end }) => ({ start, end }))
}
/** The tool/result content text for one call id. */
function resultText(agent: Agent, callId: string): string | undefined {
  const event = agent.session.events.find((e) => e.type === 'tool/result' && e.data.message.content[0]?.toolCallId === CallId(callId))
  if (event === undefined || event.type !== 'tool/result') return undefined
  const block = event.data.message.content[0]
  if (block === undefined) return undefined
  return block.content
    .map((item) => item.type === 'text' ? item.text : '')
    .join('')
}

describe('file-mount integration', () => {
  let dir: string
  let file: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-it-'))
    file = join(dir, 'subject.txt')
    await writeFile(file, ['1', '2', '3', '4', '5', '6'].map((n) => n + 'x'.repeat(39)).join('\n') + '\n', 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('anchors the first read, dedupes the second, mounts only the missing tail on the third', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 4 }),
      toolCallResponse('c2', 'read', { file_path: file, offset: 1, limit: 4 }),
      toolCallResponse('c3', 'read', { file_path: file, offset: 3, limit: 4 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-anchor'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // c1 (first read): the read result stays native; a head-only state message lands.
    expect(resultText(agent, 'c1')).toContain('<content>')
    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'increment'])
    expect(geo(sources[0]!['mounted'] as { start: number; end: number }[])).toEqual([{ start: 1, end: 4 }])
    expect(sources[0]!['savedTokens']).toBe(0)
    expect(sources[0]!['form']).toBe('notice')
    expect(sources[0]!['summary']).toBe('mounted L1-4')
    expect(sources[1]!['mountKind']).toBe('dedup')
    expect(sources[1]!['savedTokens']).toBe(40)
    expect(sources[1]!['added']).toEqual([])
    expect(sources[2]!['added']).toEqual([{ start: 5, end: 6 }])
    expect(geo(sources[2]!['mounted'] as { start: number; end: number }[])).toEqual([{ start: 1, end: 6 }])
    expect(sources[2]!['savedTokens']).toBe(20)
    expect(sources[2]!['summary']).toBe('+L5-6 - saved ≈ 20 tokens')

    // c2 (full coverage): short dedup marker, nothing re-added.
    expect(resultText(agent, 'c2')).toContain('mounted:L1-4] - already mounted, not re-added')

    // The dedup decision also leaves a short note message in the log.
    const dedupNote = agent.session.events.find((e) => e.type === 'user/message'
      && typeof e.data.source === 'object' && e.data.source !== null
      && e.data.source['mountKind'] === 'dedup')
    expect(dedupNote !== undefined && dedupNote.type === 'user/message'
      && dedupNote.data.content[0] !== undefined && dedupNote.data.content[0].type === 'text'
      ? dedupNote.data.content[0].text
      : '').toContain('saved ≈ 40 tokens')

    // c3 (partial): short content marker; the missing tail rides the injected message.
    expect(resultText(agent, 'c3')).toContain('+L5-6')
    // The result is only the short marker: the native read body wrapper is gone.
    expect(resultText(agent, 'c3')).not.toContain('<content>')

    // The injected increment message carries the missing body in model view.
    const increment = agent.session.events.find((e) => e.type === 'user/message'
      && typeof e.data.source === 'object' && e.data.source !== null
      && e.data.source['mountKind'] === 'increment')
    const incrementText = increment !== undefined && increment.type === 'user/message'
      && increment.data.content[0] !== undefined && increment.data.content[0].type === 'text'
      ? increment.data.content[0].text
      : ''
    expect(incrementText).toContain('--- L5-6 ---')

    // Ledger: one file, hash verified, ranges 1-6, cumulative savings.
    const ledger = ctx.fileMount.ledger(agent)
    expect(ledger.map((f) => f.absPath)).toEqual([normalizeAbsPath(file)])
    expect(geo(ledger[0]!.segments)).toEqual([{ start: 1, end: 6 }])
    expect(ledger[0]!.savedTokens).toBe(60)

    
  })

  it('passes tiny reads through untouched when below the savings threshold', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 4 }),
      toolCallResponse('c2', 'read', { file_path: file, offset: 1, limit: 1 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { minSavedTokens: 12 } })
    const agent = ctx.agentLoop.create(SessionId('it-threshold'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // c1 anchors L1-4 (new mount, no threshold); c2 reads one 10-token line
    // (below minSavedTokens 12) and must pass through natively.
    expect(resultText(agent, 'c2')).toContain('<content>')
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new'])
  })

  it('remounts as a fresh anchor when the file changes on disk', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 4 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: file, offset: 1, limit: 4 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-remount'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)
    await writeFile(file, ['x', 'y', 'z'].join('\n') + '\n', 'utf8')
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'remount'])
    expect(sources[1]!['hash']).not.toBe(sources[0]!['hash'])
    expect(geo(sources[1]!['mounted'] as { start: number; end: number }[])).toEqual([{ start: 1, end: 3 }])
    expect(resultText(agent, 'c2')).toContain('file changed since last mount, remounting')

    
  })

  it('re-sends only the changed line after a mid-file edit (incremental remount)', async () => {
    const subject = join(dir, 'incremental.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3', '4', '5', '6'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 6 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 6 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-incremental'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // Change only line 3 on disk; the other five lines stay byte-identical.
    const changedLine3 = 'CHANGED' + 'y'.repeat(33)
    await writeFile(subject, [line('1'), line('2'), changedLine3, line('4'), line('5'), line('6')].join('\n') + '\n', 'utf8')
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'remount'])
    expect(sources[1]!['hash']).not.toBe(sources[0]!['hash'])
    // Only the changed line is re-sent; the five unchanged lines stay mounted.
    expect(sources[1]!['added']).toEqual([{ start: 3, end: 3 }])
    expect(geo(sources[1]!['mounted'] as { start: number; end: number }[])).toEqual([{ start: 1, end: 6 }])
    expect(sources[1]!['savedTokens']).toBe(50)
    expect(resultText(agent, 'c2')).toContain('file changed: +1/-1 lines (~5 unchanged) since last mount')

    const remount = agent.session.events.find((e) => e.type === 'user/message'
      && typeof e.data.source === 'object' && e.data.source !== null
      && e.data.source['mountKind'] === 'remount')
    const remountText = remount !== undefined && remount.type === 'user/message'
      && remount.data.content[0] !== undefined && remount.data.content[0].type === 'text'
      ? remount.data.content[0].text
      : ''
    expect(remountText).toContain('--- L3 ---')
    expect(remountText).toContain('CHANGED')

    const ledger = ctx.fileMount.ledger(agent)
    expect(geo(ledger[0]!.segments)).toEqual([{ start: 1, end: 6 }])
    expect(ledger[0]!.savedTokens).toBe(50)
  })

  it('replays the ledger from the live log (resume path) before the first read', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { minSavedTokens: 0 } })
    const agent = ctx.agentLoop.create(SessionId('it-replay'), { provider: 'mock', model: 'mock' })

    // Seed the resumed log with a mount message for L1-2 (standard event type).
    const seed = createUserMessage({
      content: [{ type: 'text', text: '[file-mount: seed]' }],
      source: {
        kind: 'plugin',
        plugin: 'file-mount',
        path: normalizeAbsPath(file),
        hash: hashBuffer(await readFile(file)),
        totalLines: 6,
        mounted: [{ start: 1, end: 2 }],
        added: [{ start: 1, end: 2 }],
        mountKind: 'new',
      },
    })
    agent.session.append('user/message', seed, { surfaceOp: 'append' })

    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // The seeded ranges count as mounted: the read of L1-2 dedupes.
    expect(resultText(agent, 'c1')).toContain('already mounted, not re-added')
    expect(geo(ctx.fileMount.ledger(agent)[0]!.segments)).toEqual([{ start: 1, end: 2 }])

    
  })

  it('re-anchors when a compact checkpoint shadows the mounts (live sweep)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-compact-live'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // The anchor's state message is now shadowed by a compaction checkpoint.
    const mountEvent = agent.session.events.find((event) => event.type === 'user/message'
      && (event.data.source as unknown as Record<string, unknown> | null)?.['plugin'] === 'file-mount')
    expect(mountEvent).toBeDefined()
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[compact checkpoint]' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: 'append', sourceEventSeqs: [mountEvent!.seq] })

    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    // The claim is void: c2 re-anchors natively instead of deduping.
    expect(resultText(agent, 'c2')).toContain('<content>')
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new', 'new'])
    expect(geo(ctx.fileMount.ledger(agent)[0]!.segments)).toEqual([{ start: 1, end: 2 }])
  })

  it('does not resurrect mounts shadowed by a checkpoint on replay', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-compact-replay'), { provider: 'mock', model: 'mock' })

    // Seed a resumed-style mount message, then a checkpoint that shadows it.
    const seed = createUserMessage({
      content: [{ type: 'text', text: '[file-mount: seed]' }],
      source: {
        kind: 'plugin',
        plugin: 'file-mount',
        path: normalizeAbsPath(file),
        hash: hashBuffer(await readFile(file)),
        totalLines: 6,
        mounted: [{ start: 1, end: 2 }],
        added: [{ start: 1, end: 2 }],
        mountKind: 'new',
      },
    })
    const seedEvent = agent.session.append('user/message', seed, { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[compact checkpoint]' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: 'append', sourceEventSeqs: [seedEvent.seq] })

    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // The shadowed seed must not count: the first read anchors natively.
    expect(resultText(agent, 'c1')).toContain('<content>')
    expect(geo(ctx.fileMount.ledger(agent)[0]!.segments)).toEqual([{ start: 1, end: 2 }])
  })

  it('survives a jsonl persistence round trip (standard user/message carrier)', async () => {
    const root = join(dir, 'persist')
    const sessionId = SessionId('it-persist')

    const ctx1 = await harness(new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('done'),
    ]), { cwd: dir })
    await ctx1.plugin(JsonlSessionPersistence, { root })
    const agent1 = ctx1.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    send(agent1, 'read it')
    await waitForIdle(ctx1, agent1)
    await ctx1.fiber.dispose()

    // Fresh process shape: new context, same persistence root.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, { root })
    const inspection = await ctx2.sessionPersistence.load(sessionId)
    const mountEvents = inspection.events.filter((event) => event.type === 'user/message'
      && typeof event.data.source === 'object' && event.data.source !== null
      && event.data.source['plugin'] === 'file-mount')
    expect(mountEvents.length).toBe(1)

    const replayed = new MountStore()
    replayed.replay(mountEvents.map((event) => ({ type: event.type, source: event.data.source })))
    expect(geo(replayed.mountedSegments(normalizeAbsPath(file)))).toEqual([{ start: 1, end: 2 }])

  })

  it('re-sends only the new tail when a file grows (append-only, item 10)', async () => {
    const subject = join(dir, 'append.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3', '4'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 4 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 6 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-append'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)
    await writeFile(subject, ['1', '2', '3', '4', '5', '6'].map(line).join('\n') + '\n', 'utf8')
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'remount'])
    expect(sources[1]!['added']).toEqual([{ start: 5, end: 6 }])
    expect(geo(sources[1]!['mounted'] as { start: number; end: number }[])).toEqual([{ start: 1, end: 6 }])
    expect(resultText(agent, 'c2')).toContain('file changed: +2/-0 lines (~4 unchanged) since last mount')
  })

  it('coalesces repeated dedup notes and merges their savings into the next message (item 3)', async () => {
    const subject = join(dir, 'dedup-merge.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3', '4', '5', '6'].map(line).join('\n') + '\n', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 4 }),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 4 }),
      toolCallResponse('c3', 'read', { file_path: subject, offset: 1, limit: 4 }),
      toolCallResponse('c4', 'read', { file_path: subject, offset: 5, limit: 2 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-dedup-merge'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    // Only ONE dedup note; the second dedup is silent, the increment folds it.
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'increment'])
    expect(sources.filter((s) => s['mountKind'] === 'dedup')).toHaveLength(1)
    expect(sources[2]!['savedTokens']).toBe(40)
    // The silent dedup still replaced its result with the marker.
    expect(resultText(agent, 'c3')).toContain('already mounted, not re-added')
    // Ledger total: 40 (first dedup) + 40 (silent dedup, folded) + 0 (increment).
    expect(ctx.fileMount.ledger(agent)[0]!.savedTokens).toBe(80)
  })

  it('mounts a freshly written file as already known (item 13)', async () => {
    const subject = join(dir, 'written.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: subject, content: [line('a'), line('b'), line('c')].join('\n') + '\n' }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-write-known'), { provider: 'mock', model: 'mock' })
    send(agent, 'write it')
    await waitForIdle(ctx, agent)

    // The write mounts the whole file as known via a head-only 'new' message.
    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new'])
    expect(geo(sources[0]!['mounted'] as { start: number; end: number }[])).toEqual([{ start: 1, end: 3 }])
    // The subsequent read of the written file dedupes instead of re-sending.
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)
    expect(resultText(agent, 'c2')).toContain('already mounted, not re-added')
  })


  it('the forget tool forces the next read to re-send (item 25)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 4 }),
      toolCallResponse('c2', 'file_mount_forget', { file_path: file }),
      textResponse('first turn done'),
      toolCallResponse('c3', 'read', { file_path: file, offset: 1, limit: 4 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('it-forget'), { provider: 'mock', model: 'mock' })
    send(agent, 'read then forget')
    await waitForIdle(ctx, agent)

    // After forgetting, the same window re-anchors natively instead of deduping.
    send(agent, 'read again')
    await waitForIdle(ctx, agent)
    expect(resultText(agent, 'c3')).toContain('<content>')
    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'new'])
  })

  it('passes excluded paths through untouched (item 7)', async () => {
    const excluded = join(dir, 'vendor', 'lib.ts')
    await mkdir(join(dir, 'vendor'), { recursive: true })
    await writeFile(excluded, 'a\nb\nc\n', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: excluded, offset: 1, limit: 3 }),
      toolCallResponse('c2', 'read', { file_path: excluded, offset: 1, limit: 3 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { excludeGlobs: ['**/vendor/**'] } })
    const agent = ctx.agentLoop.create(SessionId('it-exclude'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // Both reads stay native and the plugin never mounts anything.
    expect(resultText(agent, 'c1')).toContain('<content>')
    expect(resultText(agent, 'c2')).toContain('<content>')
    expect(mountMessages(agent)).toEqual([])
  })

  it('accumulates cross-session totals into the stats file (item 24)', async () => {
    const statsPath = join(dir, 'stats.json')
    const subject = join(dir, 'stats.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3', '4'].map(line).join('\n') + '\n', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 4 }),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 4 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { statsFile: statsPath } })
    const agent = ctx.agentLoop.create(SessionId('it-stats'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)
    await ctx.fiber.dispose()
    // persistStats is fire-and-forget; give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const raw = await readFile(statsPath, 'utf8')
    const stats = JSON.parse(raw) as { sessions: number; savedTokens: number }
    expect(stats.sessions).toBe(1)
    expect(stats.savedTokens).toBe(40)
  })
})