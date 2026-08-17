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
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MountStore } from '../src/store.ts'
import { hashBuffer } from '../src/hash.ts'
import { normalizeAbsPath } from '../src/paths.ts'
import { harness, MockAdapter, textResponse, toolCallResponse, waitForIdle } from './harness.ts'

/** Text chunks with a controllable input-token usage (freshness clock). */
function textWithUsage(text: string, inputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Text chunks with a full controllable usage (uncached + cached input). */
function textWithUsageCached(text: string, inputTokens: number, cacheReadTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens, cacheReadTokens, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
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
    const ctx = await harness(adapter, { cwd: dir, config: { minSavedTokens: 0 } })
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
    expect(geo(sources[2]!['mounted'] as { start: number; end: number }[])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ])
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

    // c3 (partial): missing body is on the durable tool result; the notice is head-only.
    expect(resultText(agent, 'c3')).toContain('--- L5-6 ---')
    // The result is the mount block: the native read body wrapper is gone.
    expect(resultText(agent, 'c3')).not.toContain('<content>')

    // The injected increment message is a ledger declaration, not the body.
    const increment = agent.session.events.find((e) => e.type === 'user/message'
      && typeof e.data.source === 'object' && e.data.source !== null
      && e.data.source['mountKind'] === 'increment')
    const incrementText = increment !== undefined && increment.type === 'user/message'
      && increment.data.content[0] !== undefined && increment.data.content[0].type === 'text'
      ? increment.data.content[0].text
      : ''
    expect(incrementText).toContain('+L5-6')
    expect(incrementText).not.toContain('--- L5-6 ---')

    // Ledger: one file, hash verified, ranges 1-6, cumulative savings.
    const ledger = ctx.fileMount.ledger(agent)
    expect(ledger.map((f) => f.absPath)).toEqual([normalizeAbsPath(file)])
    expect(geo(ledger[0]!.segments)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ])
    expect(ledger[0]!.savedTokens).toBe(60)
    
  })

  it('keeps increment body on the tool result so cancel cannot drop it', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 4 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: file, offset: 3, limit: 4 }),
      toolCallResponse('c3', 'read', { file_path: file, offset: 5, limit: 2 }),
      textResponse('third turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { minSavedTokens: 0 } })
    const agent = ctx.agentLoop.create(SessionId('it-cancel-increment'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    const off = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'tool/result' && event.data.message.content[0]?.toolCallId === CallId('c2')) {
        agent.cancel({ kind: 'user' })
      }
    })
    send(agent, 'read more')
    await waitForIdle(ctx, agent)
    off()

    expect(resultText(agent, 'c2')).toContain('--- L5-6 ---')

    send(agent, 'read tail')
    await waitForIdle(ctx, agent)
    const later = resultText(agent, 'c3') ?? ''
    const bodyOnPriorResult = (resultText(agent, 'c2') ?? '').includes('--- L5-6 ---')
    const resent = later.includes('--- L5-6 ---') || later.includes('<content>')
    expect(bodyOnPriorResult || resent).toBe(true)
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

  it('passes a one-line increment through without writing the ledger', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 4 }),
      toolCallResponse('c2', 'read', { file_path: file, offset: 4, limit: 2 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { minSavedTokens: 16 } })
    const agent = ctx.agentLoop.create(SessionId('it-increment-floor'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    // Overlap is a single 10-token line; note overhead makes net < 16, so the
    // increment must pass through natively and leave the ledger at L1-4.
    expect(resultText(agent, 'c2')).toContain('<content>')
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new'])
    expect(geo(ctx.fileMount.ledger(agent)[0]!.segments)).toEqual([{ start: 1, end: 4 }])
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
    expect(geo(sources[1]!['mounted'] as { start: number; end: number }[])).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 6 },
    ])
    expect(sources[1]!['savedTokens']).toBe(50)
    expect(resultText(agent, 'c2')).toContain('file changed: +1/-1 lines (~5 unchanged) since last mount')
    expect(resultText(agent, 'c2')).toContain('--- L3 ---')
    expect(resultText(agent, 'c2')).toContain('CHANGED')

    const remount = agent.session.events.find((e) => e.type === 'user/message'
      && typeof e.data.source === 'object' && e.data.source !== null
      && e.data.source['mountKind'] === 'remount')
    const remountText = remount !== undefined && remount.type === 'user/message'
      && remount.data.content[0] !== undefined && remount.data.content[0].type === 'text'
      ? remount.data.content[0].text
      : ''
    expect(remountText).toContain('file changed')
    expect(remountText).not.toContain('--- L3 ---')
    expect(remountText).not.toContain('CHANGED')

    const ledger = ctx.fileMount.ledger(agent)
    expect(geo(ledger[0]!.segments)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 6 },
    ])
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

  it('recomputes pos from carrier seq after compact so a stale born cannot immortalize', async () => {
    const subject = join(dir, 'seq-compact.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }, 50_000),
      textWithUsage('first turn done', 50_000),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }, 400),
      textWithUsage('second turn done', 400),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { contextWindow: 600, safeTokens: 100 } })
    const agent = ctx.agentLoop.create(SessionId('it-seq-compact'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    const mountEvent = agent.session.events.find((event) => event.type === 'user/message'
      && (event.data.source as unknown as Record<string, unknown> | null)?.['plugin'] === 'file-mount')
    expect(mountEvent).toBeDefined()
    const highUsage = agent.session.events.filter((event) => {
      if (event.type !== 'assistant/message') return false
      const usage = event.data.usage
      const input = usage && typeof usage === 'object' ? (usage as { inputTokens?: number }).inputTokens : undefined
      return input === 50_000
    })
    expect(highUsage.length).toBeGreaterThan(0)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[compact checkpoint]' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: 'append', sourceEventSeqs: highUsage.map((event) => event.seq) })

    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    // Frozen born ≈ 50000 would be >= L=400 (immortal). Seq prefix puts pos
    // near the start of the remaining log, so the segment expires and re-sends.
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new', 'increment'])
    expect(resultText(agent, 'c2')).toContain('--- L1-3 ---')
  })

  it('expires from seq prefix sums when assistant usage is absent', async () => {
    const subject = join(dir, 'seq-nousage.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')
    const noUsageTool = (id: string, args: object): StreamChunk[] => {
      const callId = CallId(id)
      const argumentsJson = JSON.stringify(args)
      return [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: 'read', argumentsDelta: argumentsJson },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'read', arguments: argumentsJson } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    }
    const noUsageText = (text: string): StreamChunk[] => [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const padding = 'y'.repeat(8000)
    const adapter = new MockAdapter([
      noUsageTool('c1', { file_path: subject, offset: 1, limit: 3 }),
      noUsageText('first turn done'),
      noUsageText('padding'),
      noUsageTool('c2', { file_path: subject, offset: 1, limit: 3 }),
      noUsageText('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { contextWindow: 600, safeTokens: 100 } })
    const agent = ctx.agentLoop.create(SessionId('it-seq-nousage'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)
    send(agent, padding)
    await waitForIdle(ctx, agent)
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new', 'increment'])
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
    expect(geo(sources[1]!['mounted'] as { start: number; end: number }[])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ])
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
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 0 } })
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

  it('expired segments leave the ledger, re-send on the next read, and keep their count (freshness)', async () => {
    const subject = join(dir, 'freshness.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      textWithUsage('hi', 100),
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }, 110),
      textWithUsage('ok', 150),
      textWithUsage('grow', 800),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }, 810),
      textWithUsage('done', 850),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { contextWindow: 600, safeTokens: 100 } })
    const agent = ctx.agentLoop.create(SessionId('it-freshness'), { provider: 'mock', model: 'mock' })
    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    send(agent, 'read it')
    await waitForIdle(ctx, agent)
    send(agent, 'grow context')
    await waitForIdle(ctx, agent)
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    // Same-hash expiry: the re-send lands as an increment (not a remount).
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'increment'])
    // The fresh mount stamped a born position (context was 110 tokens).
    const first = sources[0]!['mounted'] as { start: number; end: number; born?: number; expired: number }[]
    expect(first[0]!.born).toBeGreaterThan(110)
    expect(first[0]!.expired).toBe(0)
    // After the context grew past the threshold, the whole window expired and
    // was re-sent; the re-mount inherits expired count 1 and a new born.
    const second = sources[1]!['mounted'] as { start: number; end: number; born?: number; expired: number }[]
    expect(geo(second)).toEqual([{ start: 1, end: 3 }])
    expect(second[0]!.expired).toBe(1)
    expect(second[0]!.born).toBeGreaterThan(810)
    expect(resultText(agent, 'c2')).toContain('--- L1-3 ---')
  })

  it('freshness clock counts cached input: expiry follows the FULL context, not the uncached delta', async () => {
    const subject = join(dir, 'clock-cached.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    // Request totals: 1000 -> 1100 (mount) -> 1200 -> 2300 -> 2400 (re-read).
    // The UNCACHED deltas (150 -> 400) would keep the segment "fresh" forever
    // (born > L); the full-prompt clock sees 1100 -> 2400 (mid-window valley) and expires it.
    const adapter = new MockAdapter([
      textWithUsageCached('hi', 100, 900),
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }, 150, 950),
      textWithUsageCached('ok', 200, 1000),
      textWithUsageCached('grow', 300, 2000),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }, 400, 2000),
      textWithUsageCached('done', 500, 2000),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { contextWindow: 4000, safeTokens: 100 } })
    const agent = ctx.agentLoop.create(SessionId('it-clock-cached'), { provider: 'mock', model: 'mock' })
    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    send(agent, 'read it')
    await waitForIdle(ctx, agent)
    send(agent, 'grow context')
    await waitForIdle(ctx, agent)
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'increment'])
    const first = sources[0]!['mounted'] as { start: number; end: number; born?: number; expired: number }[]
    // born anchors at the FULL context at mount (1100) + block estimate, not
    // the uncached 150.
    expect(first[0]!.born!).toBeGreaterThan(1100)
    expect(first[0]!.born!).toBeLessThan(1150)
    const second = sources[1]!['mounted'] as { start: number; end: number; born?: number; expired: number }[]
    expect(second[0]!.expired).toBe(1)
    expect(second[0]!.born!).toBeGreaterThan(2400)
    expect(resultText(agent, 'c2')).toContain('--- L1-3 ---')
  })

  it('freshness threshold follows the settings namespace when the host provides one', async () => {
    // Duck-typed stand-in for the dsh-settings seam (the plugin wires without
    // importing it): one independent scope per registered namespace, each with
    // its own watcher — mirrors the real provider, which other harness
    // plugins also register sections through.
    interface NamespaceState {
      base: { freshnessThreshold?: number } | undefined
      section: { freshnessThreshold?: number }
      watcher: (() => void) | undefined
    }
    const namespaces = new Map<string, {
      get(): { freshnessThreshold?: number }
      update(patch: { freshnessThreshold?: number }): Promise<void>
    }>()
    const fakeSettings = {
      register(ns: string, _schema: unknown, options?: { base?: unknown }) {
        const state: NamespaceState = {
          base: options?.base as { freshnessThreshold?: number } | undefined,
          section: {},
          watcher: undefined,
        }
        const scope = {
          get: () => ({ ...state.base, ...state.section }),
          watch: (callback: () => void) => {
            state.watcher = callback
            return () => { if (state.watcher === callback) state.watcher = undefined }
          },
          update: async (patch: { freshnessThreshold?: number }) => {
            state.section = { ...state.section, ...patch }
            state.watcher?.()
          },
        }
        namespaces.set(ns, scope)
        return scope
      },
    }
    const fileMountNs = () => namespaces.get('file-mount')!
    const subjectA = join(dir, 'settings-a.txt')
    const subjectB = join(dir, 'settings-b.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subjectA, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')
    await writeFile(subjectB, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subjectA, offset: 1, limit: 3 }),
      textResponse('ok'),
      toolCallResponse('c2', 'read', { file_path: subjectB, offset: 1, limit: 3 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    // Providing the service after boot still resolves the plugin's optional
    // settings seam (it listens for the provider's binding event).
    ctx.provide('settings', fakeSettings)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const agent = ctx.agentLoop.create(SessionId('it-settings'), { provider: 'mock', model: 'mock' })
    send(agent, 'read a')
    await waitForIdle(ctx, agent)
    // The config value is the base layer: the first mount stamps it.
    const first = mountMessages(agent)
    expect(first[0]!['freshnessThreshold']).toBe(0.6)
    // A runtime tier change flows into the ledger: update the namespace, then
    // the next mount source carries the new effective threshold.
    await fileMountNs().update({ freshnessThreshold: 0.75 })
    send(agent, 'read b')
    await waitForIdle(ctx, agent)
    const sources = mountMessages(agent)
    expect(sources).toHaveLength(2)
    expect(sources[sources.length - 1]!['freshnessThreshold']).toBe(0.75)
  })

  it('re-read safety valve: 2nd consecutive full dedup triggers native pass-through and resets counter', async () => {
    const subject = join(dir, 'safety-valve.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      // Turn 1: initial read (anchors as 'new')
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('turn 1 ok'),
      // Turn 2: 1st repeated read (intercepted with dedup marker)
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('turn 2 ok'),
      // Turn 3: 2nd repeated read (safety valve triggers: full content passes through)
      toolCallResponse('c3', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('turn 3 ok'),
      // Turn 4: next read intercepts again (counter reset after valve release)
      toolCallResponse('c4', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('turn 4 ok'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 2 } })
    const agent = ctx.agentLoop.create(SessionId('it-safety-valve'), { provider: 'mock', model: 'mock' })

    send(agent, 'read 1')
    await waitForIdle(ctx, agent)
    // Turn 1: native read output accepted, injected notice
    expect(resultText(agent, 'c1')).toContain('1xxx')

    send(agent, 'read 2')
    await waitForIdle(ctx, agent)
    // Turn 2: dedup intercepted
    expect(resultText(agent, 'c2')).toContain('already mounted, not re-added')

    send(agent, 'read 3')
    await waitForIdle(ctx, agent)
    // Turn 3: valve triggered, native content passes through
    expect(resultText(agent, 'c3')).toContain('1xxx')
    expect(resultText(agent, 'c3')).not.toContain('already mounted')

    const sources = mountMessages(agent)
    // Turn 1 was 'new', Turn 2 was 'dedup', Turn 3 was 'new' (valve release)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'new'])
    // The valve-released mount has expired count 1
    const last = sources[sources.length - 1]!['mounted'] as { start: number; end: number; expired: number }[]
    expect(last[0]!.expired).toBe(1)

    send(agent, 'read 4')
    await waitForIdle(ctx, agent)
    // Turn 4: dedup again (counter was reset)
    expect(resultText(agent, 'c4')).toContain('already mounted, not re-added')
  })

  it('safety valve splits straddling segments: inside-window refreshes born, outside-window keeps old born', async () => {
    const subject = join(dir, 'valve-split.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3', '4', '5', '6'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      // Turn 1: read full file L1-6
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 6 }, 100),
      textResponse('ok 1'),
      // Turn 2: read sub-window L1-3 (dedup attempt 1)
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }, 150),
      textResponse('ok 2'),
      // Turn 3: read sub-window L1-3 (valve triggers: pass-through and split)
      toolCallResponse('c3', 'read', { file_path: subject, offset: 1, limit: 3 }, 200),
      textResponse('ok 3'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 2 } })
    const agent = ctx.agentLoop.create(SessionId('it-valve-split'), { provider: 'mock', model: 'mock' })

    send(agent, 'read all')
    await waitForIdle(ctx, agent)
    send(agent, 'read head 1')
    await waitForIdle(ctx, agent)
    send(agent, 'read head 2')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'new'])
    const mountedAfterValve = sources[2]!['mounted'] as { start: number; end: number; born?: number; expired: number; tokens?: number }[]
    // Split into 2 segments: [1, 3] inside window and [4, 6] outside window
    expect(geo(mountedAfterValve)).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ])
    // Inside segment has expired 1 and fresh born (> 200)
    expect(mountedAfterValve[0]!.expired).toBe(1)
    expect(mountedAfterValve[0]!.born).toBeGreaterThan(200)
    // Outside segment retains expired 0 and older born; tokens stay proportional
    // (never rewritten as 0 just because the fragment is outside the window).
    expect(mountedAfterValve[1]!.expired).toBe(0)
    expect(mountedAfterValve[1]!.born).toBeLessThan(200)
    expect(mountedAfterValve[1]!.tokens).toBe(30)
  })

  it('tiny full-coverage reads below minSavedTokens do not advance the valve count', async () => {
    const subject = join(dir, 'valve-threshold.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 1'),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 2'),
      toolCallResponse('c3', 'read', { file_path: subject, offset: 1, limit: 1 }),
      textResponse('ok 3'),
      toolCallResponse('c4', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 4'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 2, minSavedTokens: 12 } })
    const agent = ctx.agentLoop.create(SessionId('it-valve-threshold'), { provider: 'mock', model: 'mock' })

    send(agent, 'read 1')
    await waitForIdle(ctx, agent)
    send(agent, 'read 2')
    await waitForIdle(ctx, agent)
    send(agent, 'read tiny')
    await waitForIdle(ctx, agent)
    send(agent, 'read 4')
    await waitForIdle(ctx, agent)

    expect(resultText(agent, 'c2')).toContain('already mounted')
    expect(resultText(agent, 'c3')).toContain('<content>')
    // Tiny pass-through must not count as an intercept. With valveReads=2 the
    // next full read is therefore the 2nd intercept (valve native), not a
    // post-reset dedup (which is what would happen if the tiny read had
    // already tripped the valve).
    expect(resultText(agent, 'c4')).toContain('1xxx')
    expect(resultText(agent, 'c4')).not.toContain('already mounted')
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'new'])
  })

  it('valve release folds parked silent-dedup savings into savedTokens', async () => {
    const subject = join(dir, 'valve-parked.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 1'),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 2'),
      toolCallResponse('c3', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 3'),
      toolCallResponse('c4', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 4'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 3 } })
    const agent = ctx.agentLoop.create(SessionId('it-valve-parked'), { provider: 'mock', model: 'mock' })

    send(agent, 'read 1')
    await waitForIdle(ctx, agent)
    send(agent, 'read 2')
    await waitForIdle(ctx, agent)
    send(agent, 'read 3')
    await waitForIdle(ctx, agent)
    send(agent, 'read 4')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'new'])
    // Quiet intercept parked 30 tokens; the valve notice carries them.
    expect(sources[2]!['savedTokens']).toBe(30)
    expect(ctx.fileMount.ledger(agent)[0]!.savedTokens).toBe(60)
    expect(resultText(agent, 'c4')).toContain('1xxx')
    expect(resultText(agent, 'c4')).not.toContain('already mounted')
  })

  it('valve walks pruned segments so an expired range is not resurrected', async () => {
    const subject = join(dir, 'valve-prune.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3', '4', '5', '6'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      textWithUsage('hi', 100),
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }, 200),
      textWithUsage('ok 1', 250),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 4, limit: 3 }, 400),
      textWithUsage('ok 2', 420),
      textWithUsage('grow', 500),
      toolCallResponse('c3', 'read', { file_path: subject, offset: 4, limit: 3 }, 510),
      textWithUsage('ok 3', 520),
      toolCallResponse('c4', 'read', { file_path: subject, offset: 4, limit: 3 }, 530),
      textWithUsage('ok 4', 540),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 2, contextWindow: 600, safeTokens: 100 } })
    const agent = ctx.agentLoop.create(SessionId('it-valve-prune'), { provider: 'mock', model: 'mock' })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    send(agent, 'read head')
    await waitForIdle(ctx, agent)
    send(agent, 'read tail')
    await waitForIdle(ctx, agent)
    send(agent, 'grow context')
    await waitForIdle(ctx, agent)
    send(agent, 'reread tail 1')
    await waitForIdle(ctx, agent)
    send(agent, 'reread tail 2')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'increment', 'dedup', 'new'])
    const afterValve = sources[3]!['mounted'] as { start: number; end: number }[]
    expect(geo(afterValve)).toEqual([{ start: 4, end: 6 }])
    expect(geo(ctx.fileMount.ledger(agent)[0]!.segments)).toEqual([{ start: 4, end: 6 }])
  })

  it('valveReads = 0 disables safety valve entirely', async () => {
    const subject = join(dir, 'valve-disabled.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 1'),
      toolCallResponse('c2', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 2'),
      toolCallResponse('c3', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 3'),
      toolCallResponse('c4', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('ok 4'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 0 } })
    const agent = ctx.agentLoop.create(SessionId('it-valve-disabled'), { provider: 'mock', model: 'mock' })

    send(agent, 'read 1')
    await waitForIdle(ctx, agent)
    send(agent, 'read 2')
    await waitForIdle(ctx, agent)
    send(agent, 'read 3')
    await waitForIdle(ctx, agent)
    send(agent, 'read 4')
    await waitForIdle(ctx, agent)

    // Turns 2, 3, 4 are all dedup intercepted
    expect(resultText(agent, 'c2')).toContain('already mounted')
    expect(resultText(agent, 'c3')).toContain('already mounted')
    expect(resultText(agent, 'c4')).toContain('already mounted')
  })

  it('does not write the ledger when a downstream post-execute already replaced the read value', async () => {
    const subject = join(dir, 'downstream-value.txt')
    const line = (n: string) => n + 'x'.repeat(39)
    await writeFile(subject, ['1', '2', '3'].map(line).join('\n') + '\n', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: subject, offset: 1, limit: 3 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    // Inner waterfall listener: file-mount awaits next() first, so this replacement
    // is the downstream accept. value and content are mutually exclusive.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next()
      if (exec.name !== 'read' || result.isError || downstream.kind !== 'accept') return downstream
      return { kind: 'accept' as const, value: { replaced: true, path: subject } }
    })
    const agent = ctx.agentLoop.create(SessionId('it-downstream-value'), { provider: 'mock', model: 'mock' })
    send(agent, 'read it')
    await waitForIdle(ctx, agent)

    expect(ctx.fileMount.ledger(agent)).toEqual([])
    expect(mountMessages(agent)).toEqual([])
    expect(resultText(agent, 'c1')).not.toContain('already mounted')
  })
})