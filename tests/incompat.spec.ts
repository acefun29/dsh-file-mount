/**
 * Incompatible-shape guard: when a tool's canonical value no longer matches
 * the duck-typed contract (read/write/edit), the plugin passes the result
 * through untouched and voices it ONCE PER SESSION as a notice, instead of
 * silently turning itself off. Historically a shape change left the plugin
 * inert with no signal until someone noticed the dashboard had stopped.
 *
 * The guard is driven directly through the plugin's own `tools/post-execute`
 * listener with a crafted drifted value: the real tool pipeline cannot be
 * made to emit a drifted value (its output schema rejects it first), which is
 * exactly the gap the guard exists for — a future DSH whose schema and the
 * plugin's duck-type disagree.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DSH_COMPAT_VERSION } from '../src/index.ts'
import { harness, MockAdapter, textResponse, toolCallResponse, waitForIdle } from './harness.ts'

type Accept = { kind: 'accept'; value?: unknown; additionalContexts?: unknown[] }
type Listener = (
  exec: unknown,
  result: unknown,
  next: () => Promise<Accept>,
) => Promise<Accept>

/** The plugin's own post-execute listener, read from the live context.
 * cordis stores hook entries as `{ ctx, callback, prepend }` wrappers. */
function pluginListener(ctx: Context): Listener {
  const hooks = (ctx as unknown as { events?: { _hooks?: Record<string, { callback?: Listener }[]> } }).events?._hooks
  const found = hooks?.['tools/post-execute']?.[0]?.callback
  if (found === undefined) throw new Error('file-mount post-execute listener not found')
  return found
}

/** Minimal tool execution + a drifted canonical value, driven past the guards. */
function drifted(agentId: string, tool: string, value: unknown, format = 4): { exec: unknown; result: unknown } {
  return {
    exec: {
      name: tool,
      agent: { id: agentId, session: { header: { version: format } } },
    },
    result: { isError: false, value },
  }
}

function downstream(): Accept {
  return { kind: 'accept' }
}

/** The warning notices appended to a decision (their source carries no path). */
function notices(decision: Accept): Record<string, unknown>[] {
  return (decision.additionalContexts ?? [])
    .map((message) => (message as { source?: Record<string, unknown> }).source)
    .filter((source): source is Record<string, unknown> =>
      source !== undefined && source['kind'] === 'file-mount' && !('path' in source))
}

describe('incompatible-shape guard (direct)', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-incompat-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('warns once per session for a drifted read shape, naming the tool and DSH version', async () => {
    const ctx = await harness(new MockAdapter([]), { cwd: dir })
    const listener = pluginListener(ctx)
    const { exec, result } = drifted('agent-a', 'read', { shape: 'drifted' })

    const warned = await listener(exec, result, async () => downstream())
    const text = notices(warned)
    expect(text).toHaveLength(1)
    expect(text[0]!['form']).toBe('notice')
    expect(text[0]!['summary']).toContain('read')
    expect(text[0]!['summary']).toContain(DSH_COMPAT_VERSION)
    expect(text[0]!['summary']).toContain('passing through')
    // Summary stays within the shell's one-line budget.
    expect((text[0]!['summary'] as string).length).toBeLessThanOrEqual(120)

    const decision = warned.additionalContexts![0] as { content: { text: string }[] }
    expect(decision.content[0]!.text).toContain('session format v4')
    expect(decision.content[0]!.text).toContain(DSH_COMPAT_VERSION)

    // Second drift in the same session: silent (the latch holds).
    const second = await listener(exec, result, async () => downstream())
    expect(notices(second)).toHaveLength(0)

    // A different session warns on its own.
    const other = drifted('agent-b', 'read', { shape: 'drifted' })
    const third = await listener(other.exec, other.result, async () => downstream())
    expect(notices(third)).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('warns for a drifted write shape and passes the result through', async () => {
    const ctx = await harness(new MockAdapter([]), { cwd: dir })
    const listener = pluginListener(ctx)
    const { exec, result } = drifted('agent-w', 'write', { path: 123, after: 'x' })

    const warned = await listener(exec, result, async () => downstream())
    const text = notices(warned)
    expect(text).toHaveLength(1)
    expect(text[0]!['summary']).toContain('write')
    // Pass-through: the decision is still the downstream accept, untouched.
    expect(warned.kind).toBe('accept')
    expect(warned.value).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('warns for a drifted edit shape', async () => {
    const ctx = await harness(new MockAdapter([]), { cwd: dir })
    const listener = pluginListener(ctx)
    const { exec, result } = drifted('agent-e', 'edit', { no: 'path' })

    const warned = await listener(exec, result, async () => downstream())
    const text = notices(warned)
    expect(text).toHaveLength(1)
    expect(text[0]!['summary']).toContain('edit')
    await ctx.fiber.dispose()
  })

  it('stays silent on error results and on recognized shapes', async () => {
    const ctx = await harness(new MockAdapter([]), { cwd: dir })
    const listener = pluginListener(ctx)

    // An errored read: no shape policing, no warning.
    const errored = drifted('agent-ok', 'read', undefined)
    ;(errored.result as { isError: boolean }).isError = true
    expect(notices(await listener(errored.exec, errored.result, async () => downstream()))).toHaveLength(0)

    // A recognized read value: the guard is not reached at all.
    const ok = drifted('agent-ok', 'read', { path: join(dir, 'none.txt'), offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1 })
    expect(notices(await listener(ok.exec, ok.result, async () => downstream()))).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('quotes the DSH release this build was verified against', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      engines?: { dsh?: string }
    }
    // The notice text and the package gate must move together: bumping the
    // DSH line means bumping DSH_COMPAT_VERSION in src/index.ts.
    expect(DSH_COMPAT_VERSION).toBe((pkg.engines?.dsh ?? '').replace(/^\^/, ''))
  })
})

describe('incompatible-shape guard (real session)', () => {
  let dir: string
  let file: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-file-mount-incompat-live-'))
    file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('a healthy read/write session produces no warning notice', async () => {
    const ctx = await harness(new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: file }),
      textResponse('done'),
    ]), { cwd: dir, config: { minSavedTokens: 0 } })
    const agent = await ctx.agentLoop.create(SessionId('incompat-live'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const warnNotices = (agent.session.snapshotEvents() as readonly { type?: string; data?: { source?: Record<string, unknown> } }[])
      .filter((event) => event.type === 'user/message')
      .map((event) => event.data?.source)
      .filter((source): source is Record<string, unknown> =>
        source !== undefined && source['kind'] === 'file-mount' && !('path' in source))
    expect(warnNotices).toEqual([])
    await ctx.fiber.dispose()
  })
})
