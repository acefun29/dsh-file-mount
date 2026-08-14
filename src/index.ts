/**
 * dsh-file-mount host half: incremental file mounting with read dedupe.
 *
 * One post-execute interception point owns the whole model-facing surface:
 * after a successful text `read`, the plugin verifies the file identity
 * (stat-verified cache), folds the returned window against the per-session
 * mount ledger, and returns a PostToolDecision that (a) replaces the result
 * content with a short marker when the window adds nothing new, and (b)
 * injects the new ranges as plugin-sourced additionalContexts. The canonical
 * tool value is preserved throughout, so UI read cards and the audit log
 * stay intact.
 *
 * The ledger's durable carrier is the injected message SOURCE (structured,
 * merge-extensible JSON on a standard `user/message` event), so resumed
 * sessions and the browser client fold state from persistence-safe events.
 *
 * Compaction-aware: mount messages shadowed by a compact checkpoint no longer
 * count as mounted (their content has left the model context) — both when the
 * live log gains a checkpoint and when a resumed session replays the log.
 *
 * @module dsh-file-mount
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session/types'
import { isCompactCheckpoint, shadowedSeqsOf } from './compaction.ts'
import { FileContentCache } from './file-cache.ts'
import { normalizeAbsPath } from './paths.ts'
import { subtract, type LineRange } from './ranges.ts'
import {
  formatRange,
  markerHead,
  renderDedupMarker,
  renderMountBlock,
  renderRemountMarker,
} from './render.ts'
import { MountStore, type LedgerRecord } from './store.ts'
import { estimateRangeTokens } from './tokens.ts'
import type { MountKind, MountedFile, MountSource, Segment } from './types.ts'

export { FileContentCache } from './file-cache.ts'
export { MountStore, type LedgerRecord } from './store.ts'
export { normalize, subtract, clamp, type LineRange } from './ranges.ts'
export { hashBuffer } from './hash.ts'
export { normalizeAbsPath } from './paths.ts'
export {
  formatRange,
  markerHead,
  renderDedupMarker,
  renderMountBlock,
  renderRemountMarker,
} from './render.ts'
export type { MountedFile, MountKind, MountSource, Segment } from './types.ts'

/** Plugin config: ledger limits and the global kill switch. */
export interface Config {
  /** Master switch; disabled keeps every read native. */
  enabled?: boolean
  /** File identity cache capacity (pinned mounts exempt). */
  capacity?: number
  /** File identity cache TTL (safety valve, ms). */
  ttlMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  capacity: z.number().step(1).min(1).default(32),
  ttlMs: z.number().step(1).min(1000).default(300_000),
})

export const name = 'file-mount'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live mount service: per-session ledgers plus the shared file cache. */
    fileMount: FileMountService
  }
}

/** Narrow shape of a successful `read` canonical value (v1 contract). */
interface ReadValue {
  path: string
  offset: number
  lines: { number: number; text: string }[]
  totalLines: number
}

function asReadValue(value: unknown): ReadValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['path'] !== 'string' || typeof v['offset'] !== 'number'
    || typeof v['totalLines'] !== 'number' || !Array.isArray(v['lines'])) return undefined
  const lines: { number: number; text: string }[] = []
  for (const item of v['lines']) {
    if (typeof item !== 'object' || item === null) return undefined
    const line = item as Record<string, unknown>
    if (typeof line['number'] !== 'number' || typeof line['text'] !== 'string') return undefined
    lines.push({ number: line['number'], text: line['text'] })
  }
  return { path: v['path'], offset: v['offset'], lines, totalLines: v['totalLines'] }
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/**
 * Host service: per-session mount ledgers, the stat-verified file identity
 * cache, and resume replay from injected message sources.
 */
export class FileMountService extends Service {
  static inject = []

  private readonly enabled: boolean
  private readonly cache: FileContentCache
  private readonly stores = new Map<string, MountStore>()
  private readonly restores = new Map<string, Promise<void>>()
  /** Log length each agent's ledger has folded up to (live checkpoint sweep). */
  private readonly cursors = new Map<string, number>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'fileMount')
    const resolved = Config(config)
    this.enabled = resolved.enabled ?? true
    this.cache = new FileContentCache({
      ...resolved.capacity !== undefined ? { capacity: resolved.capacity } : {},
      ...resolved.ttlMs !== undefined ? { ttlMs: resolved.ttlMs } : {},
    })

    ctx.on('agent/session-start', ({ agent, source }) => {
      if (source === 'resume') void this.kickoffRestore(agent)
      // 'clear'/'compact' are declared in DSH's SessionStartSource union but not
      // yet emitted by any harness code — defensive wiring until they are. The
      // live checkpoint sweep (storeFor) covers compaction today.
      if (source === 'clear' || source === 'compact') this.resetLedger(agent)
    })

    ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const downstream = await next()
      if (!this.enabled || downstream.kind !== 'accept' || exec.name !== 'read') return downstream
      if (exec.agent === undefined || result.isError) return downstream
      return this.onReadResult(exec.agent, result, downstream)
    })
  }

  /** Fold one successful read into the ledger and reshape the decision. */
  private async onReadResult(
    agent: Agent,
    result: ToolExecutionResult,
    downstream: Extract<PostToolDecision, { kind: 'accept' }>,
  ): Promise<PostToolDecision> {
    if (result.isError || result.value === undefined) return downstream
    const value = asReadValue(result.value)
    if (value === undefined || value.lines.length === 0
      || !Number.isSafeInteger(value.offset) || value.offset < 1) return downstream
    const absPath = normalizeAbsPath(value.path)
    const entry = await this.cache.get(absPath)
    if (entry === null) return downstream
    const store = await this.storeFor(agent)
    const existing = store.get(absPath)
    const windowStart = value.offset
    const windowEnd = Math.min(windowStart + value.lines.length - 1, value.totalLines)
    const want: LineRange = { start: windowStart, end: windowEnd }
    const mounted = existing?.segments ?? []

    if (existing !== undefined && existing.hash === entry.hash) {
      const missing = subtract(mounted, want)
      if (missing.length === 0) {
        // Full coverage: the window adds nothing. Replace the result with the
        // short marker and record the saving on a head-only state message.
        if (downstream.value !== undefined) return downstream
        const lines = value.lines.map((line) => line.text)
        const savedTokens = estimateRangeTokens(lines, windowStart, [want])
        store.mount({ absPath, hash: entry.hash, totalLines: value.totalLines, segments: [], savedTokens })
        const source = this.mountSource(store, absPath, entry.hash, value.totalLines, [], 'dedup', savedTokens)
        return {
          kind: 'accept',
          content: [textBlock(renderDedupMarker(value.path, entry.hash, mounted))],
          additionalContexts: [
            ...downstream.additionalContexts ?? [],
            this.contextMessage(
              `${markerHead(value.path, entry.hash, mounted)} - already mounted, saved ≈ ${savedTokens} tokens`,
              source,
            ),
          ],
        }
      }
      const lines = value.lines.map((line) => line.text)
      const covered = subtract(missing, want)
      const savedTokens = estimateRangeTokens(lines, windowStart, covered)
      this.mount(store, absPath, entry.hash, value.totalLines, missing, savedTokens)
      const source = this.mountSource(store, absPath, entry.hash, value.totalLines, missing, 'increment', savedTokens)
      const block = renderMountBlock({
        path: value.path,
        hash: entry.hash,
        mounted: source.mounted,
        windowStart,
        lines,
        missing,
      })
      const added = missing.map((s) => formatRange(s.start, s.end)).join(', ')
      if (downstream.value !== undefined) return downstream
      return {
        kind: 'accept',
        content: [textBlock(`[file-mount: ${value.path}] +${added} - ${missing.length === 1 ? 'range' : 'ranges'} added to context`)],
        additionalContexts: [...downstream.additionalContexts ?? [], this.contextMessage(block, source)],
      }
    }

    // New file or changed content: remount the whole window as a fresh anchor.
    const kind: MountKind = existing === undefined ? 'new' : 'remount'
    this.mount(store, absPath, entry.hash, value.totalLines, [want], 0)
    this.cache.pin(absPath)
    if (kind === 'new') {
      // First read of a file stays native (the read result IS the anchor);
      // a head-only state message carries the ledger to UI folds.
      if (downstream.value !== undefined) return downstream
      return {
        kind: 'accept',
        additionalContexts: [
          ...downstream.additionalContexts ?? [],
          this.contextMessage(
            markerHead(value.path, entry.hash, [want]),
            this.mountSource(store, absPath, entry.hash, value.totalLines, [want], 'new', 0),
          ),
        ],
      }
    }
    const source = this.mountSource(store, absPath, entry.hash, value.totalLines, [want], 'remount', 0)
    const block = renderMountBlock({
      path: value.path,
      hash: entry.hash,
      mounted: source.mounted,
      windowStart,
      lines: value.lines.map((line) => line.text),
      missing: [want],
    })
    if (downstream.value !== undefined) return downstream
    return {
      kind: 'accept',
      content: [textBlock(renderRemountMarker(value.path, entry.hash, source.mounted))],
      additionalContexts: [...downstream.additionalContexts ?? [], this.contextMessage(block, source)],
    }
  }

  /** The structured source state for one injected message. */
  private mountSource(
    store: MountStore,
    absPath: string,
    hash: string,
    totalLines: number,
    added: Segment[],
    mountKind: MountKind,
    savedTokens: number,
  ): MountSource {
    return {
      kind: 'plugin',
      plugin: 'file-mount',
      form: 'notice',
      summary: this.mountSummary(mountKind, added, savedTokens),
      path: absPath,
      hash,
      totalLines,
      mounted: store.mountedSegments(absPath),
      added,
      mountKind,
      savedTokens,
    }
  }

  /** One-line account of a mount (collapsed context-row summary). */
  private mountSummary(mountKind: MountKind, added: Segment[], savedTokens: number): string {
    if (mountKind === 'dedup') return `saved ≈ ${savedTokens} tokens`
    const ranges = added.map((s) => formatRange(s.start, s.end)).join(', ')
    if (mountKind === 'new') return `mounted ${ranges}`
    if (mountKind === 'remount') return `file changed - remounted ${ranges}`
    return savedTokens > 0 ? `+${ranges} - saved ≈ ${savedTokens} tokens` : `+${ranges}`
  }

  /** The plugin-sourced context message carrying one mount block. */
  private contextMessage(block: string, source: MountSource) {
    return createUserMessage({
      content: [{ type: 'text', text: block }],
      source,
    })
  }

  /** Record segments and pin the identity in the file cache. */
  private mount(store: MountStore, absPath: string, hash: string, totalLines: number, segments: Segment[], savedTokens: number): void {
    store.mount({ absPath, hash, totalLines, segments, savedTokens })
    this.cache.pin(absPath)
  }

  /** Per-session ledger, restored lazily on first access (resume race guard). */
  private storeFor(agent: Agent): Promise<MountStore> {
    const id = agent.id
    const existing = this.stores.get(id)
    if (existing !== undefined) {
      this.sweep(agent, existing)
      return Promise.resolve(existing)
    }
    const pending = this.restores.get(id) ?? this.kickoffRestore(agent)
    return pending.then(() => {
      let store = this.stores.get(id)
      if (store === undefined) {
        store = new MountStore()
        this.stores.set(id, store)
      }
      this.sweep(agent, store)
      return store
    })
  }

  /**
   * Mount records whose claims still hold: file-mount messages that no compact
   * checkpoint shadows. Shadowed messages stay in the raw log, but their
   * content has left the model context, so folding them would resurrect
   * stale claims (and enable false dedup).
   */
  private visibleMountRecords(agent: Agent): LedgerRecord[] {
    const events = agent.session.events
    const shadowed = shadowedSeqsOf(events)
    return events
      .filter((event) => event.type === 'user/message')
      .filter((event) => !shadowed.has(event.seq))
      .map((event) => ({ type: event.type, source: event.data.source }))
  }

  /**
   * Fold the live log tail for new compact checkpoints (DSH does not emit a
   * session-start 'compact' notification yet). Any new checkpoint — or a
   * replaced/shrunk log — re-derives the ledger from the still-visible mount
   * messages, so a claim never outlives the content it cites.
   */
  private sweep(agent: Agent, store: MountStore): void {
    const events = agent.session.events
    const cursor = this.cursors.get(agent.id)
    const start = cursor === undefined || cursor > events.length ? 0 : cursor
    let dirty = cursor !== undefined && cursor > events.length
    if (!dirty) {
      for (let i = start; i < events.length; i++) {
        if (isCompactCheckpoint(events[i])) {
          dirty = true
          break
        }
      }
    }
    this.cursors.set(agent.id, events.length)
    if (dirty) this.refold(agent, store)
  }

  /** Re-derive the ledger from the still-visible mount messages. */
  private refold(agent: Agent, store: MountStore): void {
    for (const file of store.all()) this.cache.unpin(file.absPath)
    store.clear()
    store.replay(this.visibleMountRecords(agent))
    for (const file of store.all()) this.cache.pin(file.absPath)
  }

  /** Replay the ledger from plugin-injected message sources in the live log. */
  private kickoffRestore(agent: Agent): Promise<void> {
    const existing = this.restores.get(agent.id)
    if (existing !== undefined) return existing
    const pending = (async () => {
      const store = new MountStore()
      store.replay(this.visibleMountRecords(agent))
      this.stores.set(agent.id, store)
      this.cursors.set(agent.id, agent.session.events.length)
    })().finally(() => { this.restores.delete(agent.id) })
    this.restores.set(agent.id, pending)
    return pending
  }

  /** Forget the ledger (clear/compact): the context guarantee is gone. */
  private resetLedger(agent: Agent): void {
    const store = this.stores.get(agent.id)
    if (store !== undefined) {
      for (const file of store.all()) this.cache.unpin(file.absPath)
      store.clear()
    }
  }

  /** Live ledger snapshot for UIs and tests. */
  ledger(agent: Agent): MountedFile[] {
    return this.stores.get(agent.id)?.all() ?? []
  }
}

/**
 * Register the file-mount service (the interception listener lives on the
 * service fiber so its lifecycle rides the plugin's disposal).
 * @param ctx - host context.
 * @param config - plugin config after Loader validation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(FileMountService, config)
}