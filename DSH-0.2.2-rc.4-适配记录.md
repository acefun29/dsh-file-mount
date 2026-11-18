# DSH 0.2.2-rc.4 适配记录（插件 0.10.0）

> 2026-11-18。目标：`@deepseek-ai/dsh@0.2.2-rc.4`（npm `next`；npm `latest` 仍是 0.2.2-rc.1，`alpha` 通道另到 0.2.2-alpha.3，均不追。经用户确认以 rc.4 为基线）。
> 源码参照：github.com/deepseek-ai/deepseek-harness，标签 `dsh-v0.2.2-rc.4`。注意：标签源码不足以代表 npm 产物行为，本次两处真实破坏都只能在装包实跑中暴露（见 §1 前两行）。

## 1. 与 0.2.1-rc.2 的实测差异（逐项对照标签源码 + npm 产物 + 实跑）

| 项 | 0.2.1-rc.2 | 0.2.2-rc.4 | 对本插件的影响 |
| --- | --- | --- | --- |
| **工具执行器选择**（新破坏点） | agent loop 直接执行工具 | **工具执行移到选定的 `ToolExecutor` 之后**：组合里没挂执行器时，回合直接以 `ToolExecutorUnavailableError`（"The selected tool executor is unavailable…"）报错终止，工具根本不跑 | 测试 harness 在 `Tools` 之后、`AgentRegistry` 之前挂 `ctx.plugin(NativeToolExecutor)`（`@deepseek-ai/dsh-tool-executor-native@0.2.2-rc.4`，新增 devDep）。宿主半代码不受影响（插件只监听 `tools/post-execute`），但**任何组装 agent 的宿主/测试都必须挂执行器**；官方接线顺序以 rc.4 仓库 `packages/core/agent-loop/tests/tool-executors.spec.ts` 为准 |
| **read 返回的 path 拼写**（新破坏点） | `processPath` 返回 `resolve(targetKey)`，绝对路径 | 同为 realpath 谱系（`/private/var/...`），但 `ctx.fs.config.cwd` 保持未解析拼写（`/var/...`）。静态对照两版 fs 包源码/产物字节基本一致，**差异只在实跑暴露** | 纸条 head 的相对化判定原先用原始前缀比较，工作区内文件被判成区外、head 变成绝对路径 → token 账目（`spentTokens`）随之膨胀。修复在 `displayPath`：区内外改按 realpath 身份判定（与账本 `normalizeAbsPath` 同源），缺失路径走最近存在祖先再拼回（同 fs-local `resolveLocalTarget` 的做法） |
| `ToolExecution.args` | 存在 | 已移除（`undefined`），入参校验失败改抛 `ToolArgsError` | 本插件只用 `exec.agent` / `exec.name`，无影响 |
| `PostToolDecision` | block 变体 | block 变体新增可选 `info?` | 鸭子类型守卫不动，向后兼容 |
| 兼容判定 | `engines.dsh` 单独裁决 | **不变** | `^0.2.2-rc.4` 会把 rc.1–rc.3 挡在门外（预发布参与普通范围比较），这是有意钉基线 |
| 平台模块表（seed words） | 11 项 | **逐字一致**（实测 `dsh-client-web@0.2.2-rc.4` `getStaticModules()`） | `PLATFORM_MODULES` / 冒烟 SEED_WORDS 只改注释版本号 |
| 会话格式 | v4 | **仍 v4** | 账本无需迁移；`format = 4` 断言保留 |
| read / write canonical value | read `{path,offset,lines,totalLines}`；write `{path,operation,before,after}` | **字段不变**（path 谱系变化见上） | 守卫不动 |
| `dsh.client` 清单 / `conversation.view` | `parseDshClient` 四字段 | **不变** | 客户端半业务代码零改动 |
| 依赖小版本 | cordis ^4.0.5 / schemastery ^3.18.5 | **cordis ^4.1.0 / schemastery ^3.19.0**（vendored） | peers + devDeps 提升 |

## 2. 改动清单

- `package.json`：version 0.10.0；`engines.dsh`、全部 `@deepseek-ai/dsh*` peers / devDeps → `^0.2.2-rc.4`（`dsh-working-directory` 精确钉版）；cordis → `^4.1.0`；schemastery → `^3.19.0`；devDeps 新增 `@deepseek-ai/dsh-tool-executor-native@^0.2.2-rc.4`。
- `pnpm-lock.yaml` 重生成；`pnpm-workspace.yaml` 给 rc.4 新发各包加 `minimumReleaseAgeExclude`（发布未满年龄门槛，测试环境显式放行）。
- `src/index.ts`：`DSH_COMPAT_VERSION = '0.2.2-rc.4'`。
- `src/paths.ts`：`displayPath` 按 realpath 身份判定区内外（§1 第 2 行），新增 `realOrRaw` 祖先回退。
- `tests/harness.ts`：挂 `NativeToolExecutor`（§1 第 1 行）。
- `tsdown.config.ts` / `scripts/smoke-client-boot.mjs`：模块表注释对齐 rc.4（表内容不变）。
- `README.md` / `README.en.md`：兼容表加 0.10.0 行。

宿主半与客户端半的**业务逻辑零改动**；两处 rc.4 破坏分别落在测试组装（执行器）与路径显示（realpath 谱系）上。

## 3. 验证（全部通过）

1. `pnpm test`：**242 / 242**（真实 dsh 包组装的 agent loop 集成 / 对抗 / 降级 / 源类型套件；node v24）。
2. `pnpm typecheck`：干净。
3. `pnpm build` + `pnpm run smoke:client`：产物级冒烟 6/6 通过。
4. 回归判别：同样的 3 个路径显示失败在**未改动的 rc.2 基线工作树上同样复现**（macOS `/var → /private/var` 符号链接 + 临时目录），证明 §1 第 2 行是环境暴露的既有缺陷修复而非 rc.4 特判；带修复的 `paths.ts` 在 rc.2 基线上同样全绿。

## 4. 备注

- **npm 产物 ≠ 标签源码**：执行器与 path 谱系两处都用 git diff 标签看过、判为"不变"，最后都靠实跑打脸。下轮适配把"装包跑全量测试"当作第一证据源，静态对照只用于定位。
- `engines.dsh: ^0.2.2-rc.4` 拒装 rc.1–rc.3 属预期（钉已验证基线）；如需覆盖 0.2.2 线更宽范围，等 0.2.2 final 发布后实测再放宽。
- 旧 `stash@{0}` 是本次升级中途的安全备份，内容已全部落在工作树，可择机清理。
