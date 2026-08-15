# dsh-file-mount

A DeepSeek Harness plugin: **incremental file mounting with read dedupe**. It records which line ranges of each file are already in the model context, re-reads only add the missing parts, on-disk changes re-send only the changed lines (line-level diff), and a Mounted Files dashboard shows the live ledger.

Ported from [piwpi](https://github.com/earendil-works/pi-mono)'s context-mount mechanism.

## What it does

- **Model side**: already-mounted ranges are never re-sent (dedup marker); new content flows only for the missing ranges; file edits re-send only the changed lines (append-only logs only re-send the new tail); files the AI just wrote are mounted as already known and read for free; a `file_mount_forget` tool lets the model force a fresh re-read.
- **UI side**: the Mounted Files tab is a dashboard; each file row expands into its **segments**, each with a **freshness bar** (green=fresh / yellow=aging / orange=stale / red=expired / grey=unknown) and an **expired-count badge**; plus progress bars, search, sorting, and the net-savings/CNY header; remounted rows carry a "changed, remounted" badge.
- **Savings accounting**: CJK characters count as 1 token each, other characters as chars ÷ 4; both saved tokens and the plugin's own note overhead are tracked, and the UI shows the NET figure; optional cross-session totals persist to a `statsFile`.

## Install

```sh
# From GitHub (authorize the package build in the profile's pnpm-workspace.yaml)
npx @deepseek-ai/dsh plugin --profile web add github:acefun29/dsh-file-mount

# Or a local checkout / tarball
npx @deepseek-ai/dsh plugin --profile web add file:../dsh-file-mount

npx @deepseek-ai/dsh --profile web
```

One package, two halves: `dsh.bundle.patch` mounts the host plugin row; the `dsh.client` manifest lets the web scanner pick up the browser half. No extra wiring.

## Config

```yaml
- id: file-mount
  name: dsh-file-mount
  config:
    enabled: true            # master switch; off keeps every read native
    capacity: 32             # file identity cache capacity (mounted files are pinned)
    ttlMs: 300000            # safety valve: force re-read after this interval
    maxPinnedFiles: 256      # max mounted files pinned per session
    minSavedTokens: 16       # dedup below this saving passes through natively
    maxFingerprintBytes: 1000000   # files above this keep no line draft (whole remount)
    maxManagedBytes: 16777216      # files above this are not managed at all
    excludeGlobs: ['**/node_modules/**']  # these paths always pass through
    statsFile: ./dsh-file-mount-stats.json  # optional cross-session totals file
    freshnessEnabled: true        # freshness (attention decay): on by default
    freshnessThreshold: 0.85      # drift past this counts as expired (0.85 = pushed into the top 15%)
```

## How it works

The plugin sits on the `tools/post-execute` interception point, dispatched by tool name:

1. **read**: derives the window from the canonical value; a stat-verified cache (mtime+size fast path + sha256) confirms identity; then: full coverage replaces the result with a dedup marker (only the FIRST dedup note per file between real messages — repeats are silent and their savings merge into the next message); partial coverage injects only the missing ranges; a hash change diffs the stored line draft and re-sends only the changed lines (unchanged lines just shift), falling back to a whole-window remount without a draft or for huge diffs.
2. **write**: the whole file is mounted as already known (free re-reads); the cache identity is invalidated.
3. **edit**: invalidates the cache identity; the next read uses the line-level diff.
4. Mount state travels as structured fields on injected message sources (standard `user/message` events), shared by resume replay and the browser fold through ONE merge rule (`mount-source.ts`).
5. Compaction awareness: canonical checkpoints (source `{ kind: 'plugin', plugin: 'compact' }` with `sourceEventSeqs`) shadow stale mounts, which are skipped.
6. The model can call `file_mount_forget` to invalidate a file's ledger entry (forced re-read).
7. **Freshness (attention decay)**: every mounted segment records its context position at mount time (last request FULL input tokens — uncached + cacheRead + cacheWrite; DSH usage counts are disjoint, `inputTokens` alone is the uncached portion only — plus the block estimate); per-request usage advances the current context length, and a segment's drift from the context tail maps to a display level (tail attention zone = fresh, past the threshold = expired). **Expired segments leave the ledger** (the next read re-sends them — tokens spent for reliability) and the count is kept: a re-mount inherits expired+1, shown as a badge. No timers: expiry checks only run lazily on reads.

Path identity: absolute path + `realpath` (symlinks unify to the real file) + case folding (probed per filesystem; Windows and default macOS fold).

## Known limitations

- Compaction voids the mounted guarantee: shadowed mounts are skipped and re-anchor on the next read.
- Increment/dedup/remount replace the result text, so the UI read card degrades to the generic card (the canonical value stays intact).
- Depends on the read/write/edit canonical value shapes; a shape change trips the guard and passes through natively (pinned by integration tests).
- Files over `maxManagedBytes` and `excludeGlobs` matches are not managed (no sampling — a sampled fingerprint risks missing a change and falsely deduping).
- Custom session event types cannot persist safely on rc.6, so the ledger rides structured source fields on standard events.
- Freshness is heuristic: expiry does not mean the content left the context (only compaction does) — it means attention decayed past usefulness, so re-sending is a deliberate token cost. Sessions without usage data show grey "unknown" and never expire.
- The browser conversation is a paginated history window (tail page of 50 messages by default; earlier pages load on scroll-up); the dashboard fold accumulates across snapshot revisions, so files whose mount messages scroll out of the window stay listed. Compaction-shadowed mounts are dropped host-side, but the browser has no shadow list — the row persists until the file is next re-mounted.
- Dashboard "jump to conversation", the cross-session totals UI, and live "file changed" hints are deferred (no browser-side channel).

## FAQ

- **Why does the read card degrade to a generic card?** The plugin replaces the model-visible result text (dedup marker / increment block) at post-execute; the canonical value stays intact, but the card renders from the result text.
- **How do I keep the plugin away from some files?** `excludeGlobs` for paths (e.g. `**/node_modules/**`), `maxManagedBytes` for the size cap; excluded/huge files pass through untouched.
- **How accurate are the numbers?** Estimates: CJK char ≈ 1 token, others 4 chars ≈ 1 token; the UI shows net (saved − note overhead) and a rough CNY figure (¥1 per million tokens).
- **Can the model force a re-read?** Call `file_mount_forget` to invalidate a file's ledger entry.
- **Where are cross-session totals?** Configure `statsFile`; totals accumulate there and are readable via `fileMount.stats()`. The UI display is deferred.

## Development

```sh
pnpm install
pnpm test        # vitest: unit + real read/write loop integration + persistence + compaction + freshness + client components
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc + tsdown (lib/index.js / lib/client.js)
```

**Run the tests after every DSH upgrade**: coupling points like the compaction checkpoint shape are pinned by tests (`tests/compaction.spec.ts`), so a DSH shape change fails loudly.

Peers on DSH 0.1.0-rc.5 and later (`@deepseek-ai/dsh-*`, `@deepseek-ai/cordis` ^4, React 18).

## License

MIT