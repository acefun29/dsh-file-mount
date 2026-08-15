/**
 * Integration harness: the real agent loop with the real `read` tool over a
 * local filesystem, a scripted mock LLM adapter, and the file-mount plugin —
 * the same composition the interception contract tests use (see
 * packages/core/agent-loop/tests/interception.spec.ts in the harness repo).
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import { apply as fileMountApply, type Config } from '../src/index.ts'

export interface HarnessOptions {
  /** Filesystem base directory for the read tool. */
  cwd: string
  /** Plugin kill switch (defaults to enabled). */
  enabled?: boolean
  /** Extra plugin config (e.g. minSavedTokens). */
  config?: Config
}

/** Scripted adapter: each model call consumes the next script entry. */
export class MockAdapter extends LlmAdapter {
  constructor(
    private readonly script: (StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]))[],
    private readonly reasoning?: LlmModelReasoningInfo,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(rawCallId: string, name: string, args: object, usageInputTokens = 10): StreamChunk[] {
  const callId = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: usageInputTokens, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Boot the composed harness and register the mock adapter. */
export async function harness(adapter: MockAdapter, options: HarnessOptions): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(FsLocal, { cwd: options.cwd })
  await ctx.plugin(toolFs, {})
  await ctx.plugin(fileMountApply, { enabled: options.enabled ?? true, ...options.config })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Wait until the agent settles back to idle after a followup. */
export function waitForIdle(ctx: Context, agent: { readonly id: unknown }): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}
