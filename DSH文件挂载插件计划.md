# DSH 文件挂载插件计划（dsh-file-mount）

> 目标：把 piwpi 的「文件增量挂载 / 重复读取去重」能力做成 DeepSeek Harness（DSH）插件并发布。
> 状态：规划完成，待开发。开发基线：本地 DSH checkout（0.1.0-rc.5，含便携启动器 commit），npm 最新为 0.1.0-rc.6（打包层差异，拦截面与 master 逐字节一致，已核对）。

## 1. 结论摘要

- **要移植的能力**：记录每个文件「哪些行范围已进入上下文」，重复读取只补缺、不重发；全文件 sha256 感知磁盘变化，变化即失效重挂。
- **DSH 对接口**：`tools/post-execute` 瀑布事件返回 `PostToolDecision`，可替换模型可见的 result content 且保留 canonical value；`session.append` + SessionEventMap 增广做持久化；`sessionQuery.listEvents` 做跨会话恢复。
- **生态无同类插件**（awesome-deepseek-harness 全目录 + npm 已核查）：context-doctor 是审计、dsh-at-file 是 @file 提及，均非 read 增量挂载。无重名冲突。

## 2. 命名

- 包名 **`@deepseek-ai/dsh-file-mount`**，插件 `name: 'file-mount'`，服务键 `ctx.fileMount`。
- 开发载体：工作区根目录独立仓库 `dsh-file-mount/`（本仓库），自带 `dsh.bundle.patch` + `cordis.patch.yml`，外部 `dsh plugin add` 直接安装；开发期以 `--patch` overlay 或 pnpm link 挂入 DSH checkout 测试，不修改 checkout（不污染根目录与其他目录）。
- 备选 `dsh-context-mount` 已否决：用户视角挂载的是文件内容，`file-mount` 直译、可检索、符合 `dsh-*` 家族。

## 3. 关键设计思想

1. **结果层去重，不重写输入**。DSH 官方明确推迟 pre-tool input rewrite，因此不做 piwpi 式的 offset/limit 改写；在 post-execute 替换模型可见结果。IO 照常发生，模型侧 token 节省与 piwpi 同等；canonical value 原样保留，UI / 日志 / 重放不受损。
2. **每次 read 三分支**（以 canonical value `{path, offset, lines, totalLines}` 为准，天然处理字节截断）：
   - 完全覆盖 → 短 marker（「已在上下文中，不重复挂载」），零重发；
   - 部分覆盖且 hash 未变 → marker + 仅缺失区间原文（增量挂载）；
   - hash 变化 → marker 声明文件已变化 + 整个窗口作为新锚点（版本感知失效）。
3. **首次挂载原生透传**。首个 read 保留原生格式作锚点，仅增量 / noop / 重挂载替换 content——保留首读 UI 卡片，文件原文每字节在上下文只出现一次。
4. **确定性渲染**。marker 与信封由状态唯一决定，同状态逐字节相同，保证 prompt 前缀缓存稳定。
5. **持久化与恢复**。会话事件 `file-mount/mounted` / `file-mount/invalidated` 以 `ignorable: true` 写入会话日志（独立插件的事件类型不进入 DSH 生成的 KNOWN_SESSION_EVENT_TYPES，ignorable 标记让 DSH 自身重建安全跳过、本插件自读自解释——已核实写路径 envelope 校验开放）；`agent/session-start`(resume) 触发重放，post-execute 首次访问 lazy await 防竞态。Plan B：若实测读回路径拒绝，退回 `$DSH_HOME` 下独立 sidecar JSONL。文件缓存照搬 piwpi stat 校验式设计（mtime+size 快路径、TTL 安全阀、挂载中 pin）。
6. **按仓库门禁完整交付**：invariant companion、100% 单文件覆盖率、README 的 Model Experience + Known Limitations 章节（中英）、tsconfig / catalog / knip 注册。

## 4. 分阶段计划

| 阶段 | 内容 |
|---|---|
| 1 骨架 | 独立仓库骨架：package.json（含 `dsh.bundle` manifest）/ cordis.patch.yml / src / 自包含 prepare 构建脚本 / vitest |
| 2 核心库 | `ranges.ts`、`file-cache.ts`、`types.ts`（含会话事件增广）、挂载存储 / 重放、`render.ts`；移植自 piwpi 并裁剪（fingerprint 二期） |
| 3 插件 | `index.ts`（Config + FileMountService + 两个事件监听）+ `invariant.ts` |
| 4 测试 | 单元（ranges / cache / render / store 全覆盖）+ 集成（interception.spec 模式：真 ToolRuntime + fs-local + tool-fs + mock adapter 跑真实 read 循环，含跨 ctx 持久化重放） |
| 5 发布包装 | `dsh.bundle` manifest、`cordis.patch.yml`、自包含 `prepare` 构建脚本 |
| 6 文档 | README（zh/en）+ 接线示例 + 生态目录提交入口 |
| 7 验收 | constraints / typecheck / lint / hygiene / doc-sync 全绿 + `dsh plugin add ./包.tgz` 真实安装冒烟 |

## 5. 已定取舍与风险

- v1 只接管 `read`（文本、成功结果）；grep / read_image 不接管，与 piwpi v1 一致。
- 放弃输入重写带来的 IO 节省：只省模型 token，是 DSH 官方接口约束下的正确落点。
- 已知限制（写入 README）：compaction 后「已挂载」假设可能过时（compaction 事件未纳入拦截面）；替换后 read 卡片在 UI 降级为通用卡片（canonical value 仍完整）。
- read 工具 schema 耦合：post-execute 读取 canonical value 结构，schema 变化时守卫失效 → 原生透传兜底，测试锁定该结构。
- 发布前核对 npm rc.6 无破坏性变化（主拦截面已确认一致）。

## 6. 交付物

- 源码：`packages/context/file-mount/`（index / invariant / ranges / file-cache / render / store / types）
- 测试：单元 + 集成，覆盖率 100%（仓库门禁强制）
- 文档：README.md / README.zh.md / README.i18n.yaml
- 发布件：`cordis.patch.yml` + `dsh.bundle` manifest + `prepare` 脚本
- 测试挂载：`--patch` overlay 接线 DSH checkout 的冒烟验证
