/**
 * Adversarial coverage for paths the main suite does not exercise:
 * file_mount_forget (item 25), the edit/write invalidation paths, the
 * diff-based incremental remount when the change is inside the window,
 * parked dedup savings crossing a hash change, and the error/empty
 * passthrough guards.
 *
 * The MockAdapter script is consumed in order across model calls: one `send`
 * runs the loop until the model emits a text finish, so tests that need an
 * external write between tool calls split the script across two sends
 * ([call, reply, call, reply]) and write between them.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
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


const LINE = (n: number) => n + 'x'.repeat(39)

describe('file-mount adversarial', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-ad-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  /** A fresh dedicated file per test so no test pollutes another. */
  async function freshFile(name: string, lines: number[] = [1, 2, 3, 4, 5, 6]): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, lines.map(LINE).join('\n') + '\n', 'utf8')
    return path
  }

  it('file_mount_forget drops the ledger entry and the next read re-sends (item 25)', async () => {
    const file = await freshFile('forget.txt')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 3 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'file_mount_forget', { file_path: file }),
      textResponse('second turn done'),
      toolCallResponse('c3', 'read', { file_path: file, offset: 1, limit: 3 }),
      textResponse('third turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-forget'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)
    send(agent, 'forget it')
    await waitForIdle(ctx, agent)
    send(agent, 'read it again')
    await waitForIdle(ctx, agent)

    // forget result: forgotten true.
    expect(resultText(agent, 'c2')).toContain('Mount ledger entry forgotten')
    // The next read re-anchors as a NEW mount (fresh content block).
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new', 'new'])
    expect(resultText(agent, 'c3')).toContain('<content>')
  })

  it('file_mount_forget on an unknown path reports forgotten=false', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'file_mount_forget', { file_path: join(dir, 'nope.txt') }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-forget-none'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)
    expect(resultText(agent, 'c1')).toContain('No mount ledger entry to forget')
  })

  it('an edit keeps the line draft so the next read remounts only the changed line', async () => {
    const file = await freshFile('edit.txt')
    // A stub edit tool with the canonical { path, before, after } shape: the
    // real edit tool fails with SetFileSecurityW EACCES on this Windows host
    // (fs-local's Win32 ACL preservation), unrelated to the plugin's dispatch.
    // The stub registers on the AGENT scope so it shadows the global 'edit'.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 6 }),
      toolCallResponse('c2', 'edit', { file_path: file, old_string: LINE(3), new_string: 'CHANGED' }),
      toolCallResponse('c3', 'read', { file_path: file, offset: 1, limit: 6 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-edit'), { provider: 'mock', model: 'mock' })
    agent.ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Test edit stub: applies the change directly on disk.',
      parameters: {
        file_path: { type: 'string', required: true },
        old_string: { type: 'string', required: true },
        new_string: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            before: { type: 'string', required: true },
            after: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: 'edited' }],
      },
      async execute(args) {
        const before = await (await import('node:fs/promises')).readFile(args.file_path, 'utf8')
        const after = before.replace(args.old_string, args.new_string)
        if (after === before) throw new Error('old_string not found')
        await (await import('node:fs/promises')).writeFile(args.file_path, after, 'utf8')
        return { path: args.file_path, before, after }
      },
    }))
    send(agent, 'do it')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'remount'])
    expect(sources[1]!['added']).toEqual([{ start: 3, end: 3 }])
    expect(resultText(agent, 'c3')).toContain('file changed: +1/-1 lines (~5 unchanged)')
  })

  it('a write mounts the file as known, so the next read dedupes (item 13)', async () => {
    const content = [LINE(1), LINE(2), LINE(3)].join('\n') + '\n'
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: join(dir, 'fresh.txt'), content }),
      toolCallResponse('c2', 'read', { file_path: join(dir, 'fresh.txt'), offset: 1, limit: 3 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-write'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'dedup'])
    expect(resultText(agent, 'c2')).toContain('already mounted, not re-added')
  })

  it('a mid-file external change remounts only the changed line (incremental diff)', async () => {
    const file = await freshFile('diff.txt')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 6 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: file, offset: 1, limit: 6 }),
      textResponse('second turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-diff'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)
    // External change (no write/edit tool): line 3 replaced.
    await writeFile(file, [LINE(1), LINE(2), 'CHANGED', LINE(4), LINE(5), LINE(6)].join('\n') + '\n', 'utf8')
    send(agent, 'read again')
    await waitForIdle(ctx, agent)

    const sources = mountMessages(agent)
    expect(sources.map((s) => s['mountKind'])).toEqual(['new', 'remount'])
    // Diff-based: only the changed line re-sent; survivors remapped.
    expect(sources[1]!['added']).toEqual([{ start: 3, end: 3 }])
    expect(geo(sources[1]!['mounted'] as { start: number; end: number }[])).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 6 },
    ])
    expect(resultText(agent, 'c2')).toContain('file changed: +1/-1 lines (~5 unchanged)')
    expect(resultText(agent, 'c2')).toContain('--- L3 ---')
    expect(resultText(agent, 'c2')).toContain('CHANGED')
    expect(resultText(agent, 'c2')).not.toContain(LINE(1))
    // The injected notice is head-only; the changed body rides the tool result.
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
  })

  it('parked dedup savings ride the remount after a hash change', async () => {
    const file = await freshFile('parked.txt')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 1, limit: 3 }),
      textResponse('first turn done'),
      toolCallResponse('c2', 'read', { file_path: file, offset: 1, limit: 3 }),
      textResponse('second turn done'),
      toolCallResponse('c3', 'read', { file_path: file, offset: 1, limit: 3 }),
      textResponse('third turn done'),
      toolCallResponse('c4', 'read', { file_path: file, offset: 1, limit: 3 }),
      textResponse('fourth turn done'),
    ])
    const ctx = await harness(adapter, { cwd: dir, config: { valveReads: 0 } })
    const agent = ctx.agentLoop.create(SessionId('ad-parked'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)
    send(agent, 'read again 1')
    await waitForIdle(ctx, agent)
    send(agent, 'read again 2')
    await waitForIdle(ctx, agent)
    // Reads 2 and 3 both dedup: the second is quiet and parks its savings.
    expect(mountMessages(agent).map((s) => s['mountKind'])).toEqual(['new', 'dedup'])
    // External change, then a remount that must take the parked savings.
    await writeFile(file, ['CHANGED', LINE(2), LINE(3)].join('\n') + '\n', 'utf8')
    send(agent, 'read after change')
    await waitForIdle(ctx, agent)

    const all = mountMessages(agent)
    expect(all.map((s) => s['mountKind'])).toEqual(['new', 'dedup', 'remount'])
    const remount = all[2]!
    expect(remount['added']).toEqual([{ start: 1, end: 1 }])
    // savedTokens = covered lines (L2-3, 20 tokens) + parked savings (30) = 50.
    expect(remount['savedTokens']).toBe(50)
  })

  it('reads of an empty file pass through untouched', async () => {
    const empty = join(dir, 'empty.txt')
    await writeFile(empty, '', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: empty, offset: 1, limit: 10 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-empty'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)
    expect(mountMessages(agent)).toEqual([])
    expect(resultText(agent, 'c1')).toContain('<content>')
  })

  it('reads past EOF are errors and pass through without crashing', async () => {
    const file = await freshFile('eof.txt')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file, offset: 999, limit: 3 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { cwd: dir })
    const agent = ctx.agentLoop.create(SessionId('ad-eof'), { provider: 'mock', model: 'mock' })
    send(agent, 'do it')
    await waitForIdle(ctx, agent)
    expect(mountMessages(agent)).toEqual([])
    expect(ctx.fileMount.ledger(agent)).toEqual([])
  })
})