# AGENTS.md — dsh-file-mount 开发规则

## 插件范围：只接管 read（硬性规则）

dsh-file-mount 只在 `tools/post-execute` 拦截面处理以下工具：

- `read`：核心功能——挂载 / 去重 / 增量重挂（行级 diff 只补改动的行）。
- `write`：仅配套——AI 写完文件后把整本标记为「已知道」，回头读免单；缓存指纹作废。
- `edit`：仅配套——标记缓存失效但保留行指纹底稿，下一次读走行级 diff 只补改动行。

**禁止给任何其他工具加处理。** 尤其是：

- `grep`、`glob`、`read_image` 等一律原样放行：不挂账、不去重、不改写结果文本。
- 「grep 证据行去重」曾在优化方案.md（第 23 条）规划过，已按决定砍掉并记录为「不做」——维持 v1 范围：插件只接管 read（write/edit 仅配套）。
- 任何人（人类或 AI）想给新工具加处理，必须先改本规则文件并说明理由，不许静默扩大接管面。

## 配套约定

- 任何行为变化都要测试同步（tests/）和文档同步（README.md / README.en.md / 优化方案.md）。
- 提交前全量验证：`pnpm test` + `pnpm run typecheck` + `pnpm run build` 全绿。
- `pwsh` / `shell` 等执行类工具同样不接管：原样放行。