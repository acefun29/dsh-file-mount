# DSH 文件挂载插件计划（dsh-file-mount）

> 目标：把 piwpi 的「文件增量挂载 / 重复读取去重」能力做成 DeepSeek Harness（DSH）插件并发布，后台去重 + 前台可视化。
> 状态：规划完成，待开发。开发基线：本地 DSH checkout（0.1.0-rc.5，含便携启动器 commit），npm 最新为 0.1.0-rc.6（打包层差异，拦截面与 master 逐字节一致，已核对）。

## 1. 结论摘要

- **要移植的能力**：记录每个文件「哪些行范围已进入上下文」，重复读取只补缺、不重发；全文件 sha256 感知磁盘变化，变化即失效重挂。
- **DSH 对接口**：`tools/post-execute` 瀑布事件返回 `PostToolDecision`，可替换模型可见 result content 且保留 canonical value，并通过官方 post-tool `additionalContexts` 通道注入挂载正文；`session.append` + SessionEventMap 增广做持久化；`sessionQuery.listEvents` 做跨会话恢复。
- **UI 对接口（本次新增调研）**：DSH Web UI 是「一切皆插件」的槽位体系——轨迹页本身就是 `conversation.view` 槽的注册者（ui-trajectory），上下文注入自动渲染为对话区 ContextInjectionRow，trajectory 自动把插件注入的 user/message 投影成 context 记录。第三方 UI 插件先例：context-vista（双面包 + `dsh.client` manifest + 悬浮卡）。
- **生态无同类插件**（awesome-deepseek-harness 全目录 + npm 已核查）：context-doctor 是审计、dsh-at-file 是 @file 提及，均非 read 增量挂载。无重名冲突。

## 2. 命名

- 包名 **`dsh-file-mount`**（npm 第三方可发布；`@deepseek-ai/*` scope 归官方所有，第三方发布不了——生态先例 context-vista / dsh-at-file 均为普通名），插件 `name: 'file-mount'`，服务键 `ctx.fileMount`。若日后合并进官方 monorepo 再改 `@deepseek-ai/dsh-file-mount`。
- 开发载体：工作区根目录独立仓库 `dsh-file-mount/`（本仓库），自带 `dsh.bundle.patch` + `cordis.patch.yml`，外部 `dsh plugin add` 直接安装；开发期对 npm 版 `@deepseek-ai/dsh-* 0.1.0-rc.6`（peer 依赖）开发测试，DSH checkout 仅作 API 参考与冒烟挂载，不修改 checkout（不污染根目录与其他目录）。
- 备选 `dsh-context-mount` 已否决：用户视角挂载的是文件内容，`file-mount` 直译、可检索、符合 `dsh-*` 家族。

## 3. 关键设计思想

1. **结果层去重，不重写输入**。DSH 官方明确推迟 pre-tool input rewrite，因此不做 piwpi 式的 offset/limit 改写；在 post-execute 替换模型可见结果。IO 照常发生，模型侧 token 节省与 piwpi 同等；canonical value 原样保留，UI / 日志 / 重放不受损。
2. **每次 read 三分支**（以 canonical value `{path, offset, lines, totalLines}` 为准，天然处理字节截断）：
   - 完全覆盖 → result content 换成短 marker（「已在上下文中，不重复挂载」），零重发；
   - 部分覆盖且 hash 未变 → marker + 仅缺失区间原文（增量挂载）；
   - hash 变化 → marker 声明文件已变化 + 整个窗口作为新锚点（版本感知失效）。
3. **挂载正文走 additionalContexts 注入，位置固定**（对原方案的关键修正）：替换后的 result content 只保留 marker，缺失区间的正文以 `source: {kind:'plugin', plugin:'file-mount'}` 的 user/message 注入——这是 DSH 官方支持的 post-tool 通道，且注入消息本身就是前台数据源（轨迹 context 记录 + 对话上下文行都从它投影），一举两得。首次挂载原生透传作锚点（保 UI 卡片），后续增量 / noop / 重挂载才替换。
   - **挂载位置**：由 DSH 的 post-tool additionalContexts 语义决定——注入块在触发它的那次 read 结果之后、本步骤批次结算时追加，紧邻起因（工具调用/结果与挂载正文成组）。不选请求开头（与触发点失联）、不选会话尾部（DSH 无任意位置注入通道，且跨步骤破坏因果）。
   - **位置一经写入即固定**：后续新挂载各挂各的触发点，旧块永不改写/挪动，历史前缀稳定 → provider KV 缓存友好。与 piwpi 的「每次请求重渲染尾部追加」不同：DSH 是「日志即上下文」，写进去即固定，效果等价且机制更简单。
4. **确定性渲染**。marker 与信封由状态唯一决定，同状态逐字节相同，保证 prompt 前缀缓存稳定。
5. **持久化与恢复**。会话事件 `file-mount/mounted` / `file-mount/invalidated` 以 `ignorable: true` 写入会话日志（独立插件的事件类型不进入 DSH 生成的 KNOWN_SESSION_EVENT_TYPES，ignorable 标记让 DSH 自身重建安全跳过、本插件自读自解释——已核实写路径 envelope 校验开放、history RPC 不过滤事件类型）；`agent/session-start`(resume) 触发重放，post-execute 首次访问 lazy await 防竞态。Plan B：若实测跨进程读回路径拒绝，退回 storage-domain（JSON）+ Remote 端点。文件缓存照搬 piwpi stat 校验式设计（mtime+size 快路径、TTL 安全阀、挂载中 pin）。
6. **前台展示（DSH 风格三处落地）**：
   - **轨迹页**：挂载注入自动成为 trajectory 的 context 记录（provenance 显示 file-mount，预览显示挂载块），零额外代码；
   - **对话上下文**：每次挂载自动渲染为 ContextInjectionRow（DisclosureRow 折叠行：「上下文注入 · file-mount · 摘要」，展开即挂载正文），零额外代码；
   - **「挂载文件」视图标签页**：client 半部注册 `conversation.view` 槽（与 ui-trajectory 完全同款机制），列出当前挂载文件清单——路径、hash 短码、已挂载行范围、最近事件类型（new/increment/remount）、失效状态；数据由注册 `ConversationNodeDefinition` 折叠 `file-mount/*` 会话事件得出，实时刷新；组件用 ui-primitives + locale 中英字典 + CSS modules，与 DSH 原生观感一致。
   - 双面包结构（context-vista 先例）：`dsh.client` manifest（inject: runtime/locale/ui-conversation/ui-primitives，platform web）+ exports `./client`；bundle patch 一行双挂 host/client 两半部。
7. **按仓库门禁完整交付**：invariant companion、100% 单文件覆盖率、README 的 Model Experience + Known Limitations 章节（中英）、tsconfig / catalog / knip 注册。

## 4. 分阶段计划

| 阶段 | 内容 |
|---|---|
| 1 骨架 | 独立仓库骨架：package.json（`dsh.bundle` + `dsh.client` manifest）/ cordis.patch.yml / src + src/client / 自包含 prepare 构建脚本 / vitest |
| 2 核心库 | `ranges.ts`、`file-cache.ts`、`types.ts`（含会话事件增广）、挂载存储 / 重放、`render.ts`；移植自 piwpi 并裁剪（fingerprint 二期） |
| 3 宿主插件 | `index.ts`（Config + FileMountService + post-execute / session-start 监听 + additionalContexts 注入）+ `invariant.ts` |
| 4 宿主测试 | 单元（ranges / cache / render / store 全覆盖）+ 集成（interception.spec 模式：真 ToolRuntime + fs-local + tool-fs + mock adapter 跑真实 read 循环，含跨 ctx 持久化重放） |
| 5 客户端 UI | `client/` 半部：`conversation.view` 槽注册「挂载文件」视图 + file-mount 事件折叠 store + ui-primitives 组件 + 中英 locale；client 测试（client-test-runtime 槽位 bench 模式，jsdom） |
| 6 发布包装 | `dsh.bundle` manifest、`cordis.patch.yml`（host + client 两行）、自包含 `prepare` 构建脚本 |
| 7 文档 | README（zh/en）+ 接线示例 + 生态目录提交入口 |
| 8 验收 | 全部测试 + 类型检查 + `dsh plugin add ./包.tgz` 真实安装冒烟：web profile 启动后浏览器可见「挂载文件」标签页、对话上下文行、轨迹 context 记录 |

## 5. 已定取舍与风险

- v1 只接管 `read`（文本、成功结果）；grep / read_image 不接管，与 piwpi v1 一致。
- 放弃输入重写带来的 IO 节省：只省模型 token，是 DSH 官方接口约束下的正确落点。
- 已知限制（写入 README）：compaction 后「已挂载」假设可能过时（compaction 事件未纳入拦截面）；替换后 read 卡片在 UI 降级为通用卡片（canonical value 仍完整）。
- read 工具 schema 耦合：post-execute 读取 canonical value 结构，schema 变化时守卫失效 → 原生透传兜底，测试锁定该结构。
- 跨进程读回未知事件类型需实测（已确认 live 路径与 history RPC 无过滤；持久化 load 路径以 ignorable 标记跳过）；失败即切换 Plan B storage-domain。
- 客户端 peer 依赖锁定 npm 版 `@deepseek-ai/dsh-client-*` `^0.1.0-rc.6` + `@deepseek-ai/cordis` `^4`（context-vista 实测先例）；发布前核对 rc.6 无破坏性变化（主拦截面已确认一致）。
- 发布形态单一 package 双面（host + client），避免拆两个包；若 `dsh.client` 行与 host 行同包有冲突，拆 `dsh-file-mount-ui` 次包。

## 6. 交付物

- 源码：`src/`（index / invariant / ranges / file-cache / render / store / types）+ `src/client/`（视图 / store / locales / 组件）
- 测试：宿主单元 + 集成 + 客户端组件测试，覆盖率 100%
- 文档：README.md / README.zh.md
- 发布件：`cordis.patch.yml`（host + client 两行）+ `dsh.bundle` / `dsh.client` manifest + `prepare` 脚本
- 验收：`--patch` overlay 接线 DSH checkout 冒烟 + `dsh plugin add` 安装冒烟（浏览器三处可见）

## 7. 后续优化（本期不做，仅记录）

- **Token 节省统计与提醒**（MVP 后优先做）：每次去重时估算省下的 token 并在 UI 给出提醒。设计预想：
  - 数据来源：宿主在 `file-mount/*` 事件里附带 `savedTokens` 估算（noop = 整个被去重窗口的 token 数；增量 = 已覆盖区间的 token 数；按「字符数 ÷ 4」粗略估算，精确 tokenizer 二期再议），客户端事件折叠自然汇总，无需新增数据通道；
  - 展示形态（DSH 风格）：挂载文件视图顶部加「本次会话累计节省 ≈ N tokens」汇总行；单次去重时在对话的上下文注入行摘要里显示「节省 ≈ N tokens」；后续可加一次性 toast 提醒；
  - 边界：只算因本插件去重而不再进入上下文的部分，不重复计算。
- **fingerprint 移植**：piwpi 的行级 / 块级指纹与变更行数量化，配合未来可能的跨会话磁盘驱动失效判定。
- **grep 挂载**：grep 结果的证据式挂载，v1 不接管。
- **compaction 联动**：待 DSH 把 compaction 纳入拦截面后，压缩时同步失效已挂载区间。
- **输入重写省 IO**：待 DSH 开放 pre-tool input rewrite 后，增量读取改写 offset/limit 减少磁盘 IO（当前只省模型 token）。
