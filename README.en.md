# dsh-file-mount

A DeepSeek Harness plugin: **incremental file mounting with read dedupe**. It records which line ranges of each file are already in the model context, re-reads only add the missing parts, on-disk changes invalidate and remount automatically, and a Mounted Files tab shows the live ledger.

Ported from [piwpi](https://github.com/earendil-works/pi-mono)'s context-mount mechanism.

## What it does

- **Model side**: already-mounted ranges are never re-sent (dedup marker), new content flows only for the missing ranges (incremental mount), disk changes invalidate and remount (version awareness). Rendering is deterministic, keeping the prompt prefix cache stable.
- **UI side**: conversation rows show each mount as a foldable file-mount context injection whose summary states the savings (e.g. "saved ≈ 300 tokens"); the trajectory shows the matching context records; the conversation tab ring gains a Mounted Files tab listing path, hash, mounted ranges, and state live, with a session-total savings header.
- **Savings accounting**: coarse char-count ÷ 4 estimates (dedup = the whole suppressed window, increment = the already-covered part); totals survive file changes and session resume.

## Install

```sh
# From npm
npx @deepseek-ai/dsh plugin --profile web add dsh-file-mount

# Or from GitHub (authorize the package build in the profile's pnpm-workspace.yaml)
npx @deepseek-ai/dsh plugin --profile web add github:you/dsh-file-mount

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
    enabled: true      # master switch; off keeps every read native
    capacity: 32       # file identity cache capacity (mounted files are pinned)
    ttlMs: 300000      # safety valve: force re-read after this interval
```

## How it works

The plugin sits on the `tools/post-execute` interception point:

1. It derives the read window from the canonical value (path/offset/lines/totalLines).
2. A stat-verified cache (mtime+size fast path + sha256) confirms the on-disk identity.
3. Three branches: full coverage replaces the result with a dedup marker and injects a short "saved ≈ N tokens" note; partial coverage replaces it with a short marker and injects the missing ranges through the official post-tool additionalContexts channel (the source carries the savings); a hash change declares the file changed and remounts the window fresh.
4. Mount state travels as structured fields on the injected message source (a standard `user/message` event), shared by resume replay and the browser fold.

## Known limitations

- Compaction breaks the mounted guarantee: DSH has not opened compaction to the interception surface, so the plugin clears its ledger when a session rebuilds after compaction and recovers naturally on the next reads.
- Increment/dedup/remount replace the result text, so the UI read card degrades to the generic card (the canonical value stays intact).
- The plugin depends on the read tool's canonical value shape; a shape change trips the guard and passes through natively (pinned by the integration test).
- Custom session event types cannot persist safely on rc.6 (the load path hard-refuses unknown types), so the ledger rides structured source fields on standard events; this can migrate once DSH opens an external event-type registration surface.

## Development

```sh
pnpm install
pnpm test        # vitest: unit + real read-loop integration + persistence round trip + client components
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc + tsdown (lib/index.js / lib/invariant.js / lib/client.js)
```

Peers on DSH 0.1.0-rc.6 (`@deepseek-ai/dsh-*`, `@deepseek-ai/cordis` ^4, React 18).

## License

MIT