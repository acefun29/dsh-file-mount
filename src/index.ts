/**
 * dsh-file-mount host half: incremental file mounting with read dedupe.
 *
 * One post-execute interception point owns the whole model-facing surface:
 * after a successful text `read`, the plugin verifies the file identity
 * (stat-verified cache), folds the returned window against the per-session
 * mount ledger, and returns a PostToolDecision that (a) puts missing or
 * changed line bodies into the durable tool-result content (so cancel cannot
 * drop them), (b) replaces a fully-covered window with a short marker, and
 * (c) injects a head-only ledger notice as plugin-sourced additionalContexts.
 * The canonical tool value is preserved throughout, so UI read cards and the
 * audit log stay intact.
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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session/types'
import { isCompactCheckpoint, shadowedSeqsOf } from './compaction.ts'
import { diffLines, diffStats, remapSegments } from './diff.ts'
import { matchesAnyGlob } from './glob.ts'
import { FileContentCache } from './file-cache.ts'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { inheritHistory, normalizeLedger, parseMountSource, pruneExpired } from './mount-source.ts'
import { normalizeAbsPath } from './paths.ts'
import { normalize, subtract, type LineRange } from './ranges.ts'
import {
  formatRange,
  markerHead,
  renderDedupMarker,
  renderMountBlock,
  renderRemountMarker,
} from './render.ts'
import { MountStore, type LedgerRecord } from './store.ts'
import { estimateRangeTokens, estimateTokens } from './tokens.ts'
import type { ExpiredSegment, LedgerSegment, MountKind, MountedFile, MountSource, Segment } from './types.ts'

export { FileContentCache } from './file-cache.ts'
export { MountStore, type LedgerRecord } from './store.ts'
export { normalize, subtract, type LineRange } from './ranges.ts'
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
  /** Per-session mounted-file pin cap (bounds the identity cache). */
  maxPinnedFiles?: number
  /** Minimum token saving before a dedup is worth the marker overhead. */
  minSavedTokens?: number
  /** Files larger than this keep no line fingerprints (whole-window remount). */
  maxFingerprintBytes?: number
  /** Glob patterns of paths the plugin never manages (e.g. node_modules). */
  excludeGlobs?: string[]
  /** Files larger than this are not managed at all (never read or cached). */
  maxManagedBytes?: number
  /** Optional path of the cross-session stats file (plan item 24). */
  statsFile?: string
  /** Freshness tracking: deep content expires as the prompt fills the window. */
  freshnessEnabled?: boolean
  /** Score below which a segment counts as expired (0..1, default 0.6). */
  freshnessThreshold?: number
  /** Fraction of the context window below which pressure is 0 (default 0.85). */
  safeRatio?: number
  /** Absolute Lsafe override; when set, takes precedence over safeRatio. */
  safeTokens?: number
  /** Expired count at which a segment is pinned and no longer pruned (default 1). */
  pinAfter?: number
  /** Context window W in tokens when the session has not reported one (default 128000). */
  contextWindow?: number
  /** Optional cap: do not expire a segment whose token estimate exceeds this. */
  resendBudget?: number
  /** Re-read safety valve count (integer >= 0, default 2: pass-through on 2nd full intercept; 0 = disabled). */
  valveReads?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  capacity: z.number().step(1).min(1).default(32),
  ttlMs: z.number().step(1).min(1000).default(300_000),
  maxPinnedFiles: z.number().step(1).min(1).default(256),
  minSavedTokens: z.number().step(1).min(0).default(16),
  maxFingerprintBytes: z.number().step(1).min(1).default(1_000_000),
  excludeGlobs: z.array(z.string()).default([]),
  maxManagedBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
  statsFile: z.string(),
  freshnessEnabled: z.boolean().default(true),
  freshnessThreshold: z.number().step(0.01).min(0).max(1).default(0.6),
  safeRatio: z.number().min(0).max(1).default(0.85),
  safeTokens: z.number().step(1).min(0),
  pinAfter: z.number().step(1).min(0).default(1),
  contextWindow: z.number().step(1).min(1).default(128_000),
  resendBudget: z.number().step(1).min(0),
  valveReads: z.number().step(1).min(0).default(2),
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

/** Narrow shape shared by write/edit canonical values (both carry a path). */
function asPathValue(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['path'] !== 'string' || v['path'].length === 0) return undefined
  return v['path']
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** Lines after the marker-head of a mount block (the durable missing-range body). */
function mountBlockBody(block: string): string {
  const newline = block.indexOf('\n')
  return newline === -1 ? '' : block.slice(newline + 1)
}

/**
 * Host service: per-session mount ledgers, the stat-verified file identity
 * cache, and resume replay from injected message sources.
 */
export class FileMountService extends Service {
  static inject = ['tools']

  private readonly enabled: boolean
  private readonly maxPinnedFiles: number
  private readonly minSavedTokens: number
  private readonly cache: FileContentCache
  private readonly stores = new Map<string, MountStore>()
  private readonly restores = new Map<string, Promise<void>>()
  /** Log length each agent's ledger has folded up to (live checkpoint sweep). */
  private readonly cursors = new Map<string, number>()
  /** Per-session pin LRU: agent id -> mounted paths, most recent last. */
  private readonly pinOrders = new Map<string, string[]>()
  /** Emit the incompatible-read warning at most once per process. */
  private compatWarned = false
  /** Per-session silent-dedup savings waiting to ride the next real message. */
  private readonly pendingDedup = new Map<string, Map<string, number>>()
  /** Per-session current context length (latest request FULL prompt tokens:
   * uncached input + cacheRead + cacheWrite, from usage — DSH counts are
   * disjoint). */
  private readonly contextL = new Map<string, number>()
  private readonly excludeGlobs: readonly string[]
  private readonly statsFile: string | undefined
  private readonly freshnessEnabled: boolean
  private readonly freshnessThreshold: number
  private readonly safeRatio: number
  private readonly safeTokens: number | undefined
  private readonly pinAfter: number
  private readonly contextWindow: number
  private readonly resendBudget: number | undefined
  private readonly valveReads: number
  /** Per-session consecutive full-dedup intercept counts for safety valve: agentId -> absPath -> count. */
  private readonly valveCounts = new Map<string, Map<string, number>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'fileMount')
    const resolved = Config(config)
    this.enabled = resolved.enabled ?? true
    this.maxPinnedFiles = resolved.maxPinnedFiles ?? 256
    this.minSavedTokens = resolved.minSavedTokens ?? 16
    this.excludeGlobs = resolved.excludeGlobs ?? []
    this.statsFile = resolved.statsFile
    this.freshnessEnabled = resolved.freshnessEnabled ?? true
    this.freshnessThreshold = resolved.freshnessThreshold ?? 0.6
    this.safeRatio = resolved.safeRatio ?? 0.85
    this.safeTokens = resolved.safeTokens
    this.pinAfter = resolved.pinAfter ?? 1
    this.contextWindow = resolved.contextWindow ?? 128_000
    this.resendBudget = resolved.resendBudget
    this.valveReads = resolved.valveReads ?? 2
    this.cache = new FileContentCache({
      ...resolved.capacity !== undefined ? { capacity: resolved.capacity } : {},
      ...resolved.ttlMs !== undefined ? { ttlMs: resolved.ttlMs } : {},
      ...resolved.maxFingerprintBytes !== undefined ? { maxFingerprintBytes: resolved.maxFingerprintBytes } : {},
      ...resolved.maxManagedBytes !== undefined ? { maxManagedBytes: resolved.maxManagedBytes } : {},
    })

    this.registerForgetTool(ctx)

    ctx.on('agent/session-start', ({ agent, source }) => {
      if (source === 'resume') void this.kickoffRestore(agent).catch(() => {})
      // 'clear'/'compact' are declared in DSH's SessionStartSource union but not
      // yet emitted by any harness code — defensive wiring until they are. The
      // live checkpoint sweep (storeFor) covers compaction today.
      if (source === 'clear' || source === 'compact') this.resetLedger(agent)
    })

    ctx.on('agent/disposed', ({ agent }) => this.disposeLedger(agent))
    // Flush cross-session totals when the plugin fiber unloads (reliable even
    // though agent/disposed may not precede plugin disposal).
    ctx.effect(() => () => { this.persistAllStats() }, 'file-mount stats flush')

    ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const downstream = await next()
      if (!this.enabled || downstream.kind !== 'accept') return downstream
      if (exec.agent === undefined || result.isError) return downstream
      if (exec.name === 'read') return this.onReadResult(exec.agent, result, downstream)
      if (exec.name === 'write') return this.onWriteResult(exec.agent, result, downstream)
      if (exec.name === 'edit') {
        this.onEditResult(exec.agent, result.value)
        return downstream
      }
      return downstream
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
    if (value === undefined) {
      // The read result no longer matches the v1 contract (read tool schema
      // changed?): surface a one-time warning instead of silently passing through.
      return this.warnIncompat(downstream)
    }
    if (value.lines.length === 0
      || !Number.isSafeInteger(value.offset) || value.offset < 1) return downstream
    try {
      return await this.onReadResultInner(agent, value, downstream)
    } catch {
      // A mount decision must never fail a read: fall back to the native result.
      return downstream
    }
  }

  /** Register the model-facing "return the book" tool (plan item 25). */
  private registerForgetTool(ctx: Context): void {
    const service = this
    ctx.tools.register(defineTool({
      name: 'file_mount_forget',
      description: 'Forget the file-mount ledger entry for a file so the next read re-sends its content. Call this when a previous read said the file was already mounted but you cannot find that content in the conversation above, then read the file again.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path whose mount ledger entry should be forgotten.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { forgotten: { type: 'boolean', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.forgotten ? 'Mount ledger entry forgotten; the next read will re-send the file content.' : 'No mount ledger entry to forget.' }],
      },
      async execute(args, exec) {
        const absPath = normalizeAbsPath(args.file_path)
        service.cache.invalidate(absPath)
        let forgotten = false
        if (exec.agent !== undefined) {
          const store = await service.storeFor(exec.agent)
          if (store.get(absPath) !== undefined) {
            store.invalidate(absPath)
            forgotten = true
          }
          service.pendingDedup.get(exec.agent.id)?.delete(absPath)
          service.clearValveCount(exec.agent.id, absPath)
        }
        return { forgotten }
      },
    }))
  }

  /** A write puts the full new content into the model's context, so mount the
   * file as already known: the next read dedupes instead of re-sending (plan
   * item 13). The cache identity is invalidated first so no stale draft
   * survives the write. */
  private async onWriteResult(
    agent: Agent,
    result: ToolExecutionResult,
    downstream: Extract<PostToolDecision, { kind: 'accept' }>,
  ): Promise<PostToolDecision> {
    const path = asPathValue(result.value)
    if (path === undefined) return downstream
    const absPath = normalizeAbsPath(path)
    this.cache.invalidate(absPath)
    this.clearValveCount(agent.id, absPath)
    this.pendingDedup.get(agent.id)?.delete(absPath)
    try {
      const lookup = await this.cache.lookup(absPath)
      if (lookup === null) return downstream
      const entry = lookup.current
      if (entry.lineCount < 1) return downstream
      const store = await this.storeFor(agent)
      const want: LineRange = { start: 1, end: entry.lineCount }
      const head = markerHead(path, entry.hash, [want])
      const spentTokens = estimateTokens(head)
      const fresh = this.stampBornWrite(agent.id, head, want)
      this.mount(store, agent.id, absPath, entry.hash, entry.lineCount, fresh, 0, spentTokens)
      return this.acceptWith(
        downstream,
        [this.contextMessage(head, this.mountSource(store, absPath, entry.hash, entry.lineCount, [want], 'new', 0, spentTokens))],
      )
    } catch {
      return downstream
    }
  }

  /** An edit changes only a region, so the whole file is NOT known: mark
   * the cache stale but keep the line-fingerprint draft so the next read
   * re-reads disk and remounts only the changed lines (plan item 9). */
  private onEditResult(agent: Agent | undefined, value: unknown): void {
    const path = asPathValue(value)
    if (path === undefined) return
    const absPath = normalizeAbsPath(path)
    this.cache.markStale(absPath)
    if (agent !== undefined) {
      this.clearValveCount(agent.id, absPath)
      this.pendingDedup.get(agent.id)?.delete(absPath)
    } else {
      for (const perAgent of this.valveCounts.values()) perAgent.delete(absPath)
      for (const perAgent of this.pendingDedup.values()) perAgent.delete(absPath)
    }
  }

  private getValveCount(agentId: string, absPath: string): number {
    return this.valveCounts.get(agentId)?.get(absPath) ?? 0
  }

  private setValveCount(agentId: string, absPath: string, count: number): void {
    let perAgent = this.valveCounts.get(agentId)
    if (perAgent === undefined) {
      perAgent = new Map()
      this.valveCounts.set(agentId, perAgent)
    }
    perAgent.set(absPath, count)
  }

  private clearValveCount(agentId: string, absPath: string): void {
    const perAgent = this.valveCounts.get(agentId)
    if (perAgent !== undefined) {
      perAgent.delete(absPath)
      if (perAgent.size === 0) this.valveCounts.delete(agentId)
    }
  }

  /** Take (and clear) the silent-dedup savings pending for a session+file, so
   * they ride the next real message and resume reconstruction stays exact. */
  private takePendingSaved(agentId: string, absPath: string): number {
    const perAgent = this.pendingDedup.get(agentId)
    const pending = perAgent?.get(absPath) ?? 0
    if (perAgent !== undefined) {
      perAgent.delete(absPath)
      if (perAgent.size === 0) this.pendingDedup.delete(agentId)
    }
    return pending
  }

  /** Serializes stats-file merges so concurrent disposals cannot lose totals. */
  private statsWrite = Promise.resolve()

  /** Cross-session ledger (plan item 24): merge one store's totals into the
   * configured stats file (atomic tmp + rename; never throws). */
  private persistStats(store: MountStore): Promise<void> {
    if (this.statsFile === undefined) return Promise.resolve()
    const files = store.all()
    if (files.length === 0) return Promise.resolve()
    const saved = files.reduce((n, file) => n + file.savedTokens, 0)
    const spent = files.reduce((n, file) => n + file.spentTokens, 0)
    this.statsWrite = this.statsWrite.then(async () => {
      try {
        let current: { sessions: number; savedTokens: number; spentTokens: number } = { sessions: 0, savedTokens: 0, spentTokens: 0 }
        try {
          current = JSON.parse(await readFile(this.statsFile!, 'utf8')) as typeof current
        } catch {
          // First run or unreadable file: start fresh.
        }
        current.sessions += 1
        current.savedTokens = Math.min(Number.MAX_SAFE_INTEGER, current.savedTokens + saved)
        current.spentTokens = Math.min(Number.MAX_SAFE_INTEGER, current.spentTokens + spent)
        const tmp = this.statsFile! + '.tmp'
        await writeFile(tmp, JSON.stringify(current, null, 2), 'utf8')
        await rename(tmp, this.statsFile!)
      } catch {
        // Stats persistence must never break the host.
      }
    })
    return this.statsWrite
  }

  /** Persist every live store at service shutdown (reliable cross-session
   * totals even though agent/disposed may not precede plugin disposal). */
  private persistAllStats(): void {
    for (const store of this.stores.values()) void this.persistStats(store)
  }

  /** Cross-session totals from the stats file (or null when unavailable). */
  async stats(): Promise<{ sessions: number; savedTokens: number; spentTokens: number } | null> {
    if (this.statsFile === undefined) return null
    try {
      const parsed = JSON.parse(await readFile(this.statsFile, 'utf8')) as { sessions?: number; savedTokens?: number; spentTokens?: number }
      return {
        sessions: typeof parsed.sessions === 'number' ? parsed.sessions : 0,
        savedTokens: typeof parsed.savedTokens === 'number' ? parsed.savedTokens : 0,
        spentTokens: typeof parsed.spentTokens === 'number' ? parsed.spentTokens : 0,
      }
    } catch {
      return null
    }
  }

  /** Decision body after the cheap guards, isolated so it can never throw out. */
  private async onReadResultInner(
    agent: Agent,
    value: ReadValue,
    downstream: Extract<PostToolDecision, { kind: 'accept' }>,
  ): Promise<PostToolDecision> {
    // Another post-execute plugin already replaced the canonical value: do not
    // write the ledger or swap content (value and content are mutually exclusive).
    if (downstream.value !== undefined) return downstream
    const absPath = normalizeAbsPath(value.path)
    // Plan item 7: excluded paths (e.g. node_modules) are never managed.
    if (this.excludeGlobs.length > 0 && matchesAnyGlob(absPath, this.excludeGlobs)) return downstream
    const lookup = await this.cache.lookup(absPath)
    if (lookup === null) return downstream
    const entry = lookup.current
    const store = await this.storeFor(agent)
    const existing = store.get(absPath)
    const windowStart = value.offset
    const windowEnd = Math.min(windowStart + value.lines.length - 1, value.totalLines)
    const want: LineRange = { start: windowStart, end: windowEnd }
    const lines = value.lines.map((line) => line.text)

    // New file: the read result IS the anchor; a head-only state message
    // carries the ledger to UI folds and resume replay.
    if (existing === undefined) {
      this.clearValveCount(agent.id, absPath)
      const head = markerHead(value.path, entry.hash, [want])
      const spentTokens = estimateTokens(head)
      const pendingSaved = this.takePendingSaved(agent.id, absPath)
      const fresh = this.stampBornNew(agent.id, want, lines, windowStart)
      this.mount(store, agent.id, absPath, entry.hash, value.totalLines, fresh, pendingSaved, spentTokens)
      return this.acceptWith(
        downstream,
        [this.contextMessage(
          head,
          this.mountSource(store, absPath, entry.hash, value.totalLines, [want], 'new', pendingSaved, spentTokens),
        )],
      )
    }

    // File changed on disk: try an incremental remount (plan item 9) - diff the
    // stored draft against the new content and keep only the shifted survivors,
    // re-sending just what changed. Falls back to a whole-window remount when
    // there is no matching draft (or nothing survived the diff).
    if (existing.hash !== entry.hash) {
      this.clearValveCount(agent.id, absPath)
      const previous = lookup.previous
      const diffable = lookup.changed
        && previous !== undefined
        && previous.hash === existing.hash
        && previous.lineHashes.length > 0
        && entry.lineHashes.length > 0
        && entry.lineCount === value.totalLines
      let baseMounted: LedgerSegment[] = []
      let stats: { added: number; removed: number; unchanged: number } | undefined
      if (diffable) {
        const oldToNew = diffLines(previous.lineHashes, entry.lineHashes)
        const remapped = remapSegments(existing.segments, oldToNew)
        if (remapped.length > 0) {
          baseMounted = remapped
          stats = diffStats(oldToNew, entry.lineCount)
        }
      }
      const missing = subtract(baseMounted, want)
      const block = renderMountBlock({
        path: value.path,
        hash: entry.hash,
        mounted: normalize([...baseMounted, ...missing]),
        windowStart,
        lines,
        missing,
      })
      const covered = subtract(missing, want)
      const pendingSaved = this.takePendingSaved(agent.id, absPath)
      const savedTokens = estimateRangeTokens(lines, windowStart, covered) + pendingSaved
      const marker = renderRemountMarker(value.path, entry.hash, normalize([...baseMounted, ...missing]), stats)
      const spentTokens = estimateTokens(marker)
      // Fresh born metadata on the re-sent ranges; history (expired counts)
      // survives the hash change and is inherited by overlapping re-mounts.
      const blockHead = markerHead(value.path, entry.hash, normalize([...baseMounted, ...missing]))
      const fresh = this.stampBornRanges(agent.id, blockHead, missing, lines, windowStart)
      const inherited = inheritHistory(fresh, existing.expiredHistory)
      const postMounted = normalizeLedger([...baseMounted, ...inherited.segments])
      this.mount(store, agent.id, absPath, entry.hash, value.totalLines, postMounted, savedTokens, spentTokens, inherited.history)
      const source = this.mountSource(store, absPath, entry.hash, value.totalLines, missing, 'remount', savedTokens, spentTokens)
      const body = mountBlockBody(block)
      const content = body.length > 0 ? `${marker}\n${body}` : marker
      return this.acceptWith(downstream, [this.contextMessage(marker, source)], [textBlock(content)])
    }

    // Unchanged file: dedup (full coverage) or increment (missing ranges only).
    // Freshness (attention-decay plan): lazily drop expired segments BEFORE any
    // dedup decision — expired content stops deduping (the next read re-sends
    // it) and its count moves into the per-file history, which the re-mount
    // inherits. No timers: this check only runs on reads.
    let history = existing.expiredHistory
    let mounted = existing.segments
    if (this.freshnessEnabled) {
      const pruned = pruneExpired(mounted, this.contextL.get(agent.id), this.freshnessThreshold, {
        safeRatio: this.safeRatio,
        pinAfter: this.pinAfter,
        contextWindow: this.windowW(agent),
        ...this.safeTokens !== undefined ? { safeTokens: this.safeTokens } : {},
        ...this.resendBudget !== undefined ? { resendBudget: this.resendBudget } : {},
      })
      mounted = pruned.active
      history = [...history, ...pruned.history]
    }
    const missing = subtract(mounted, want)
    if (missing.length === 0) {
      // Full coverage: tiny windows pass through without counting as an
      // intercept, so they cannot trip the safety valve early.
      const savedTokens = estimateRangeTokens(lines, windowStart, [want])
      if (savedTokens < this.minSavedTokens) return downstream

      // Safety valve: the Nth consecutive real intercept (valveReads) passes
      // the native read through and refreshes in-window segments.
      if (this.valveReads > 0) {
        const count = this.getValveCount(agent.id, absPath) + 1
        if (count >= this.valveReads) {
          this.clearValveCount(agent.id, absPath)
          const pendingSaved = this.takePendingSaved(agent.id, absPath)
          const outsideSegments: LedgerSegment[] = []
          const newHistory: ExpiredSegment[] = [...history]
          let maxOverlapExpired = 0

          for (const seg of mounted) {
            if (seg.end < want.start || seg.start > want.end) {
              outsideSegments.push(seg)
            } else {
              const overlapStart = Math.max(seg.start, want.start)
              const overlapEnd = Math.min(seg.end, want.end)
              newHistory.push({
                start: overlapStart,
                end: overlapEnd,
                expired: seg.expired + 1,
              })
              maxOverlapExpired = Math.max(maxOverlapExpired, seg.expired + 1)
              if (seg.start < overlapStart) {
                const tokens = this.scaleSegmentTokens(seg, seg.start, overlapStart - 1)
                outsideSegments.push({
                  start: seg.start,
                  end: overlapStart - 1,
                  ...seg.born !== undefined ? { born: seg.born } : {},
                  ...seg.seq !== undefined ? { seq: seg.seq } : {},
                  ...tokens !== undefined ? { tokens } : {},
                  expired: seg.expired,
                })
              }
              if (seg.end > overlapEnd) {
                const tokens = this.scaleSegmentTokens(seg, overlapEnd + 1, seg.end)
                outsideSegments.push({
                  start: overlapEnd + 1,
                  end: seg.end,
                  ...seg.born !== undefined ? { born: seg.born } : {},
                  ...seg.seq !== undefined ? { seq: seg.seq } : {},
                  ...tokens !== undefined ? { tokens } : {},
                  expired: seg.expired,
                })
              }
            }
          }

          const freshSeg = this.stampBornNew(agent.id, want, lines, windowStart)[0]!
          freshSeg.expired = maxOverlapExpired
          const postMounted = normalizeLedger([...outsideSegments, freshSeg])
          const head = markerHead(value.path, entry.hash, postMounted)
          const spentTokens = estimateTokens(head)
          store.replaceSegments(absPath, postMounted, newHistory, pendingSaved, spentTokens)
          const source = this.mountSource(store, absPath, entry.hash, value.totalLines, [want], 'new', pendingSaved, spentTokens)
          return this.acceptWith(downstream, [this.contextMessage(head, source)])
        }
        this.setValveCount(agent.id, absPath, count)
      }

      // Full coverage dedup: persist pruned active segments and history
      const marked = this.pendingDedup.get(agent.id)?.has(absPath) ?? false
      if (!marked) {
        let perAgent = this.pendingDedup.get(agent.id)
        if (perAgent === undefined) {
          perAgent = new Map()
          this.pendingDedup.set(agent.id, perAgent)
        }
        perAgent.set(absPath, 0)
        const noteText = `${markerHead(value.path, entry.hash, mounted)} - already mounted, saved ≈ ${savedTokens} tokens`
        const spentTokens = estimateTokens(noteText)
        store.replaceSegments(absPath, mounted, history, savedTokens, spentTokens)
        const source = this.mountSource(store, absPath, entry.hash, value.totalLines, [], 'dedup', savedTokens, spentTokens)
        return this.acceptWith(
          downstream,
          [this.contextMessage(noteText, source)],
          [textBlock(renderDedupMarker(value.path, entry.hash, mounted))],
        )
      }
      // Repeated dedup: quiet. Persist pruned state and merge savings.
      store.replaceSegments(absPath, mounted, history, 0, 0)
      const prior = this.pendingDedup.get(agent.id)!.get(absPath)!
      this.pendingDedup.get(agent.id)!.set(absPath, prior + savedTokens)
      return this.acceptWith(
        downstream,
        [],
        [textBlock(renderDedupMarker(value.path, entry.hash, mounted))],
      )
    }
    this.clearValveCount(agent.id, absPath)
    const covered = subtract(missing, want)
    const added = missing.map((s) => formatRange(s.start, s.end)).join(', ')
    const note = `[file-mount: ${value.path}] +${added} - ${missing.length === 1 ? 'range' : 'ranges'} added to context`
    const spentTokens = estimateTokens(note)
    const coveredSaved = estimateRangeTokens(lines, windowStart, covered)
    const pendingPeek = this.pendingDedup.get(agent.id)?.get(absPath) ?? 0
    // A window that is entirely new (expiry re-send, pure tail) must still
    // land in the ledger. The floor only refuses overlap-saves that do not
    // pay for the note.
    if (this.minSavedTokens > 0 && covered.length > 0 && coveredSaved + pendingPeek - spentTokens < this.minSavedTokens) return downstream
    const pendingSaved = this.takePendingSaved(agent.id, absPath)
    const savedTokens = coveredSaved + pendingSaved
    const block = renderMountBlock({
      path: value.path,
      hash: entry.hash,
      mounted: normalize([...mounted, ...missing]),
      windowStart,
      lines,
      missing,
    })
    const blockHead = markerHead(value.path, entry.hash, normalize([...mounted, ...missing]))
    const fresh = this.stampBornRanges(agent.id, blockHead, missing, lines, windowStart)
    const inherited = inheritHistory(fresh, history)
    const postMounted = normalizeLedger([...mounted, ...inherited.segments])
    this.mount(store, agent.id, absPath, entry.hash, value.totalLines, postMounted, savedTokens, spentTokens, inherited.history)
    const source = this.mountSource(store, absPath, entry.hash, value.totalLines, missing, 'increment', savedTokens, spentTokens)
    return this.acceptWith(downstream, [this.contextMessage(note, source)], [textBlock(block)])
  }

  /**
   * Fold extra plugin contexts (and optional content) onto a downstream accept
   * without dropping another listener's additionalContexts. Content is only
   * set when the caller already ruled out a value replacement.
   */
  private acceptWith(
    downstream: Extract<PostToolDecision, { kind: 'accept' }>,
    extraContexts: ReturnType<FileMountService['contextMessage']>[],
    content?: { type: 'text'; text: string }[],
  ): PostToolDecision {
    const additionalContexts = [...downstream.additionalContexts ?? [], ...extraContexts]
    if (content === undefined) return { ...downstream, additionalContexts }
    return { kind: 'accept', content, additionalContexts }
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
    spentTokens: number,
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
      spentTokens,
      freshnessThreshold: this.freshnessThreshold,
    }
  }

  /** One-line account of a mount (collapsed context-row summary). */
  private mountSummary(mountKind: MountKind, added: Segment[], savedTokens: number): string {
    if (mountKind === 'dedup') return `saved ≈ ${savedTokens} tokens`
    const ranges = added.map((s) => formatRange(s.start, s.end)).join(', ')
    if (mountKind === 'new') return `mounted ${ranges}`
    if (mountKind === 'remount') return ranges.length > 0 ? `file changed - re-sent ${ranges}` : 'file changed'
    return savedTokens > 0 ? `+${ranges} - saved ≈ ${savedTokens} tokens` : `+${ranges}`
  }

  /** The plugin-sourced context message carrying one mount block. */
  private contextMessage(block: string, source: MountSource) {
    return createUserMessage({
      content: [{ type: 'text', text: block }],
      source,
    })
  }

  /** Record segments and pin the identity in the file cache for one session. */
  private mount(store: MountStore, agentId: string, absPath: string, hash: string, totalLines: number, segments: LedgerSegment[], savedTokens: number, spentTokens: number, history: ExpiredSegment[] = []): void {
    store.mount({ absPath, hash, totalLines, segments, savedTokens, spentTokens, expiredHistory: history })
    this.pinFor(agentId, absPath)
  }

  /** Scale a segment's token estimate onto a sub-range by line count.
   * Out-of-window fragments have no lines to re-estimate; writing 0 would
   * look like "unknown volume" and must be avoided. */
  private scaleSegmentTokens(seg: LedgerSegment, start: number, end: number): number | undefined {
    if (seg.tokens === undefined) return undefined
    const oldLen = seg.end - seg.start + 1
    if (oldLen <= 0 || end < start) return undefined
    const scaled = Math.round(seg.tokens * (end - start + 1) / oldLen)
    return scaled > 0 ? scaled : undefined
  }

  /** Stamp fresh-born and tokens on a newly mounted single range (initial read or safety-valve remount). */
  private stampBornNew(
    agentId: string,
    want: LineRange,
    lines: readonly string[],
    windowStart: number,
  ): LedgerSegment[] {
    const contextLength = this.contextL.get(agentId)
    const segTokens = estimateRangeTokens(lines, windowStart, [want])
    return [{
      start: want.start,
      end: want.end,
      ...contextLength !== undefined ? { born: contextLength + segTokens } : {},
      tokens: segTokens,
      expired: 0,
    }]
  }

  /** Stamp fresh-born and tokens on newly mounted ranges in an injected block. */
  private stampBornRanges(
    agentId: string,
    blockHead: string,
    ranges: readonly LineRange[],
    lines: readonly string[],
    windowStart: number,
  ): LedgerSegment[] {
    const contextLength = this.contextL.get(agentId)
    let offsetInBlock = estimateTokens(blockHead)
    const fresh: LedgerSegment[] = []
    for (const range of ranges) {
      const segTokens = estimateRangeTokens(lines, windowStart, [range])
      const headerTokens = estimateTokens(`--- ${formatRange(range.start, range.end)} ---`)
      offsetInBlock += headerTokens + segTokens
      fresh.push({
        start: range.start,
        end: range.end,
        ...contextLength !== undefined ? { born: contextLength + offsetInBlock } : {},
        tokens: segTokens,
        expired: 0,
      })
    }
    return fresh
  }

  /** Stamp fresh-born on a write mount (tokens unknown, born at status message). */
  private stampBornWrite(agentId: string, head: string, want: LineRange): LedgerSegment[] {
    const contextLength = this.contextL.get(agentId)
    const born = contextLength === undefined ? undefined : contextLength + estimateTokens(head)
    return [{
      start: want.start,
      end: want.end,
      ...born !== undefined ? { born } : {},
      expired: 0,
    }]
  }
  /** Pin a mounted file for one session, honoring the per-session cap (LRU). */
  private pinFor(agentId: string, absPath: string): void {
    let order = this.pinOrders.get(agentId)
    if (order === undefined) {
      order = []
      this.pinOrders.set(agentId, order)
    }
    const at = order.indexOf(absPath)
    if (at !== -1) order.splice(at, 1)
    order.push(absPath)
    this.cache.pin(absPath, agentId)
    while (order.length > this.maxPinnedFiles) {
      const oldest = order.shift()!
      this.cache.unpin(oldest, agentId)
    }
  }

  /** Reconcile the cache pins with one session's current ledger. */
  private resyncPins(agentId: string, store: MountStore): void {
    this.cache.unpinAll(agentId)
    this.pinOrders.set(agentId, [])
    for (const file of store.all()) this.pinFor(agentId, file.absPath)
  }

  /** Drop one session's in-memory ledger and cache pins (session teardown). */
  private disposeLedger(agent: Agent): void {
    const id = agent.id
    const store = this.stores.get(id)
    this.cache.unpinAll(id)
    this.pinOrders.delete(id)
    this.stores.delete(id)
    this.cursors.delete(id)
    this.restores.delete(id)
    this.pendingDedup.delete(id)
    this.contextL.delete(id)
    this.valveCounts.delete(id)
    if (store !== undefined) void this.persistStats(store)
  }

  /** One-time warning when the read result shape is no longer recognized. */
  private warnIncompat(downstream: Extract<PostToolDecision, { kind: 'accept' }>): PostToolDecision {
    if (this.compatWarned) return downstream
    this.compatWarned = true
    return {
      ...downstream,
      additionalContexts: [
        ...downstream.additionalContexts ?? [],
        createUserMessage({
          content: [{ type: 'text', text: '[file-mount] the read result shape is not recognized — this plugin is passing reads through untouched. Update dsh-file-mount for this DSH version.' }],
          source: { kind: 'plugin', plugin: 'file-mount', form: 'notice', summary: 'file-mount: read result shape not recognized — passing through' },
        }),
      ],
    }
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
    // One tail pass: detect compaction checkpoints AND track the session's
    // current context length (latest request input tokens) for freshness.
    for (let i = start; i < events.length; i++) {
      const event = events[i]
      if (!dirty && isCompactCheckpoint(event)) dirty = true
      this.trackContextLength(agent.id, event)
    }
    this.cursors.set(agent.id, events.length)
    if (dirty) this.refold(agent, store)
    this.reposition(agent, store)
  }

  /** Session-advertised context window, or the configured default. */
  private windowW(agent: Agent): number {
    return agent.session.requestContext()?.contextWindow ?? this.contextWindow
  }

  /** Tokens reported on one assistant/message (DISJOINT usage sum). */
  private usageTokens(event: { type: string; data?: unknown }): number | undefined {
    if (event.type !== 'assistant/message') return undefined
    const data = event.data
    if (typeof data !== 'object' || data === null) return undefined
    const usage = (data as Record<string, unknown>)['usage']
    if (typeof usage !== 'object' || usage === null) return undefined
    const tokens = usage as Record<string, unknown>
    const parts = [tokens['inputTokens'], tokens['cacheReadTokens'], tokens['cacheWriteTokens']]
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (parts.length === 0) return undefined
    return parts.reduce((total, part) => total + part, 0)
  }

  /** Rough token count of one visible event's own payload (not the full prompt). */
  private estimateEventTokens(event: { type: string; data?: unknown }): number {
    const usage = this.usageTokens(event)
    if (event.type === 'assistant/message' && usage !== undefined) {
      const output = typeof (event.data as { usage?: { outputTokens?: number } } | undefined)?.usage?.outputTokens === 'number'
        ? (event.data as { usage: { outputTokens: number } }).usage.outputTokens
        : 0
      return Math.max(1, output)
    }
    const text = this.eventText(event)
    return text.length > 0 ? estimateTokens(text) : 0
  }

  private eventText(event: { type: string; data?: unknown }): string {
    const data = event.data
    if (typeof data !== 'object' || data === null) return ''
    const record = data as Record<string, unknown>
    const blocks = record['content'] ?? (typeof record['message'] === 'object' && record['message'] !== null
      ? (record['message'] as Record<string, unknown>)['content']
      : undefined)
    if (!Array.isArray(blocks)) return ''
    const parts: string[] = []
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const item = block as Record<string, unknown>
      if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text'])
      else if (typeof item['content'] === 'string') parts.push(item['content'])
      else if (Array.isArray(item['content'])) {
        for (const inner of item['content']) {
          if (typeof inner === 'object' && inner !== null && (inner as Record<string, unknown>)['type'] === 'text'
            && typeof (inner as Record<string, unknown>)['text'] === 'string') {
            parts.push((inner as Record<string, unknown>)['text'] as string)
          }
        }
      }
    }
    return parts.join('\n')
  }

  /**
   * Bind carrier seq onto added ranges and refresh `born` from the prefix
   * sum of visible events before that seq. Legacy segments with only `born`
   * keep it as pos.
   */
  private reposition(agent: Agent, store: MountStore): void {
    const events = agent.session.events
    const shadowed = shadowedSeqsOf(events)
    const posBySeq = new Map<number, number>()
    let prefix = 0
    let usageL: number | undefined
    for (const event of events) {
      if (shadowed.has(event.seq)) continue
      posBySeq.set(event.seq, usageL ?? prefix)
      const fromUsage = this.usageTokens(event)
      if (fromUsage !== undefined) usageL = fromUsage
      prefix += this.estimateEventTokens(event)
    }
    if (usageL !== undefined) this.contextL.set(agent.id, usageL)
    else if (prefix > 0) this.contextL.set(agent.id, prefix)

    for (const event of events) {
      if (shadowed.has(event.seq) || event.type !== 'user/message') continue
      const parsed = parseMountSource(event.data.source)
      if (parsed === undefined || parsed.mountKind === 'dedup') continue
      const source = event.data.source as Record<string, unknown>
      const addedRaw = source['added']
      const added = Array.isArray(addedRaw)
        ? addedRaw.filter((item): item is { start: number; end: number } => {
          if (typeof item !== 'object' || item === null) return false
          const rec = item as Record<string, unknown>
          return typeof rec['start'] === 'number' && typeof rec['end'] === 'number'
        })
        : parsed.delta.segments
      if (added.length === 0) continue
      const file = store.get(parsed.path)
      if (file === undefined) continue
      const next = file.segments.map((seg) => {
        const hit = added.some((range) => range.start <= seg.end && range.end >= seg.start)
        if (!hit) return seg
        return { ...seg, seq: event.seq }
      })
      store.replaceSegments(parsed.path, next, file.expiredHistory, 0, 0)
    }

    for (const file of store.all()) {
      const next = file.segments.map((seg) => {
        if (seg.seq === undefined) return seg
        const pos = posBySeq.get(seg.seq)
        if (pos === undefined) return seg
        return { ...seg, born: pos }
      })
      store.replaceSegments(file.absPath, next, file.expiredHistory, 0, 0)
    }
  }

  /**
   * Update the per-session context length from one assistant/message usage.
   * DSH's TokenUsage counts are DISJOINT: `inputTokens` is the UNCACHED input
   * only, with the cached prefix reported separately as cacheReadTokens /
   * cacheWriteTokens. Freshness measures a segment's position in the REAL
   * prompt, so the clock must be the sum of all three — using the uncached
   * delta alone makes L wiggle with cache noise (hundreds on hits, the full
   * context on misses), expiring fresh mounts on noise and never expiring
   * buried ones.
   */
  private trackContextLength(agentId: string, event: unknown): void {
    if (typeof event !== 'object' || event === null) return
    const record = event as Record<string, unknown>
    if (record['type'] !== 'assistant/message') return
    const data = record['data']
    if (typeof data !== 'object' || data === null) return
    const usage = (data as Record<string, unknown>)['usage']
    if (typeof usage !== 'object' || usage === null) return
    const tokens = usage as Record<string, unknown>
    const parts = [tokens['inputTokens'], tokens['cacheReadTokens'], tokens['cacheWriteTokens']]
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (parts.length === 0) return
    this.contextL.set(agentId, parts.reduce((total, part) => total + part, 0))
  }

  /** Re-derive the ledger from the still-visible mount messages. */
  private refold(agent: Agent, store: MountStore): void {
    store.clear()
    store.replay(this.visibleMountRecords(agent))
    this.resyncPins(agent.id, store)
    this.pendingDedup.delete(agent.id)
    this.valveCounts.delete(agent.id)
  }
  /** Replay the ledger from plugin-injected message sources in the live log. */
  private kickoffRestore(agent: Agent): Promise<void> {
    const existing = this.restores.get(agent.id)
    if (existing !== undefined) return existing
    const pending = (async () => {
      const store = new MountStore()
      try {
        store.replay(this.visibleMountRecords(agent))
      } catch {
        // A defensive replay must never reject: an empty ledger is always safe
        // (the next reads simply re-anchor). Never let restore crash the host.
      }
      this.stores.set(agent.id, store)
      this.cursors.set(agent.id, agent.session.events.length)
      this.reposition(agent, store)
      this.resyncPins(agent.id, store)
    })().finally(() => { this.restores.delete(agent.id) })
    this.restores.set(agent.id, pending)
    return pending
  }

  /** Forget the ledger (clear/compact): the context guarantee is gone. */
  private resetLedger(agent: Agent): void {
    const store = this.stores.get(agent.id)
    if (store !== undefined) store.clear()
    this.cache.unpinAll(agent.id)
    this.pinOrders.delete(agent.id)
    this.pendingDedup.delete(agent.id)
    this.contextL.delete(agent.id)
    this.valveCounts.delete(agent.id)
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