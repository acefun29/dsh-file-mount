/**
 * Integration coverage: the plugin composed into the real loop with the real
 * `read` tool over a temp filesystem. Scenarios: anchor + dedup + increment,
 * hash-change remount, lazy replay from the live session log, and a jsonl
 * persistence round trip (the standard user/message carrier must survive).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    await writeFile(file, ['1', '2', '3', '4', '5', '6'].join('\n') + '\n', 'utf8')
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
    expect(sources[0]!['mounted']).toEqual([{ start: 1, end: 4 }])
    expect(sources[0]!['savedTokens']).toBe(0)
    expect(sources[0]!['form']).toBe('notice')
    expect(sources[0]!['summary']).toBe('mounted L1-4')
    expect(sources[1]!['mountKind']).toBe('dedup')
    expect(sources[1]!['savedTokens']).toBe(4)
    expect(sources[1]!['added']).toEqual([])
    expect(sources[2]!['added']).toEqual([{ start: 5, end: 6 }])
    expect(sources[2]!['mounted']).toEqual([{ start: 1, end: 6 }])
    expect(sources[2]!['savedTokens']).toBe(2)
    expect(sources[2]!['summary']).toBe('+L5-6 - saved ≈ 2 tokens')

    // c2 (full coverage): short dedup marker, nothing re-added.
    expect(resultText(agent, 'c2')).toContain('mounted:L1-4] - already mounted, not re-added')

    // The dedup decision also leaves a short note message in the log.
    const dedupNote = agent.session.events.find((e) => e.type === 'user/message'
      && typeof e.data.source === 'object' && e.data.source !== null
      && e.data.source['mountKind'] === 'dedup')
    expect(dedupNote !== undefined && dedupNote.type === 'user/message'
      && dedupNote.data.content[0] !== undefined && dedupNote.data.content[0].type === 'text'
      ? dedupNote.data.content[0].text
      : '').toContain('saved ≈ 4 tokens')

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
    expect(ledger[0]!.segments).toEqual([{ start: 1, end: 6 }])
    expect(ledger[0]!.savedTokens).toBe(6)

    
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
    expect(sources[1]!['mounted']).toEqual([{ start: 1, end: 3 }])
    expect(resultText(agent, 'c2')).toContain('file changed since last mount, remounting')

    
  })

  it('replays the ledger from the live log (resume path) before the first read', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 2 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
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
    expect(ctx.fileMount.ledger(agent)[0]?.segments).toEqual([{ start: 1, end: 2 }])

    
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
    expect(replayed.mountedSegments(normalizeAbsPath(file))).toEqual([{ start: 1, end: 2 }])

  })
})