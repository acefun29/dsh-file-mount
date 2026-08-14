# dsh-file-mount

DeepSeek Harness 插件：**文件增量挂载 + 重复读取去重**。记录每个文件哪些行范围已经进入模型上下文，重复读取只补缺失部分，文件在磁盘上变化时自动失效重挂，并提供一个「挂载文件」标签页实时展示账本。

移植自 [piwpi](https://github.com/earendil-works/pi-mono) 的 context-mount 机制。

## 效果

- **模型侧**：读过的行范围不重复进上下文（去重 marker），新内容只注入缺失区间（增量挂载），磁盘变化即失效重挂（版本感知）；渲染格式确定，prompt 前缀缓存稳定。
- **界面侧**：对话区出现「上下文注入 · file-mount」折叠行（摘要显示本次节省，如「saved ≈ 300 tokens」）；轨迹页出现对应 context 记录；对话区标签栏新增「挂载文件」标签页，实时列出路径、指纹、已挂载行范围与状态，顶部显示本次会话累计节省 token 数。
- **节省统计**：按「字符数 ÷ 4」粗略估算（去重 = 整个被去重窗口，增量 = 已覆盖区间）；累计值跨文件变化与会话恢复保持一致。

## 安装

```sh
# 从 GitHub（需在 profile 的 pnpm-workspace.yaml 里授权该包的 prepare 构建）
npx @deepseek-ai/dsh plugin --profile web add github:acefun29/dsh-file-mount

# 或本地目录 / tarball
npx @deepseek-ai/dsh plugin --profile web add file:../dsh-file-mount

npx @deepseek-ai/dsh --profile web
```

一个包两面：`dsh.bundle.patch` 挂载宿主插件行，`dsh.client` manifest 让 Web 端扫描出浏览器半部，无需额外配置。

## 配置

```yaml
- id: file-mount
  name: dsh-file-mount
  config:
    enabled: true      # 总开关；关闭后所有读取原生透传
    capacity: 32       # 文件身份缓存容量（挂载中文件不受淘汰影响）
    ttlMs: 300000      # 缓存安全阀：同 stat 内容被改的兜底重读间隔
```

## 工作原理

插件挂在 `tools/post-execute` 拦截面：

1. 以 read 工具返回的 canonical value（path/offset/lines/totalLines）为准确定本次窗口；
2. 经 stat 校验式缓存（mtime+size 快路径 + sha256）核实磁盘身份；
3. 三分支决策：完全覆盖 → 结果换成去重 marker 并注入一条「saved ≈ N tokens」笔记消息；部分覆盖 → 结果换成短 marker + 经官方 additionalContexts 通道注入缺失区间（source 携带节省量）；hash 变化 → 声明文件已变更并整体重挂；
4. 挂载状态结构化写入注入消息的 source（标准 `user/message` 事件），恢复重放与浏览器折叠共用同一载体；
5. 压缩感知：识别 DSH 标准压缩 checkpoint（source `{kind:'plugin', plugin:'compact'}` 的 `sourceEventSeqs`），被 shadow 的挂载消息不再计入账本（在线增量扫描 + 恢复重放跳过），保证不去重已离开上下文的内容。

## 已知限制

- compaction 后「已挂载」保证失效：DSH 在会话 surface 层用 checkpoint 替换旧区间，被替换的挂载内容随之离开模型上下文。插件从 checkpoint 事件的 `sourceEventSeqs` 识别被 shadow 的挂载消息——在线扫描（每次读取增量检查日志尾部）与恢复重放（跳过 shadow 消息）双路防复活——下一次读取自然重新锚定，绝不去重「已不在上下文」的内容。挂载状态本身无法写入压缩摘要，压缩后重新挂载需重新计入 token。
- 增量 / 去重 / 重挂载替换了结果文本，UI 的 read 卡片降级为通用卡片（canonical value 完整保留）。
- 依赖 read 工具 canonical value 的结构；结构变化时守卫失效并原生透传（集成测试锁定该结构）。
- 自定义会话事件类型在 rc.6 无法安全持久化（加载路径硬性拒绝未知类型），故账本载体选用标准事件上的结构化 source；DSH 开放外部事件类型注册面后可迁移。

## 开发

```sh
pnpm install
pnpm test        # vitest（74 用例：单元 + 真实 read 循环集成 + 持久化往返 + 压缩感知 + 客户端组件）
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc + tsdown（lib/index.js / lib/client.js）
```

依赖 DSH 0.1.0-rc.5 及以上（peer 依赖 `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis` ^4、React 18）。

## License

MIT