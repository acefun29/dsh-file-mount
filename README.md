# dsh-file-mount

DeepSeek Harness 插件：**文件增量挂载 + 重复读取去重**。记录每个文件哪些行范围已经进入模型上下文，重复读取只补缺失部分；文件在磁盘上变化时按行级对比只补改动的行；并提供「挂载文件」仪表盘实时展示账本。

移植自 [piwpi](https://github.com/earendil-works/pi-mono) 的 context-mount 机制。

## 效果

- **模型侧**：读过的行范围不重复进上下文（去重 marker）；新内容只注入缺失区间（增量挂载）；文件改动后只补改动的行（行级 diff，日志追加只补新尾巴）；AI 自己写过的文件回头读直接免单；`file_mount_forget` 工具让模型能主动强制重读。
- **界面侧**：「挂载文件」标签页是仪表盘——彩色进度条（看过百分之几）、搜索框、按净节省/路径排序、顶部显示本次会话净节省并折算人民币；对话区有上下文注入折叠行，「文件已变更」时行上有角标。
- **节省统计**：中文按 1 字 ≈ 1 token、其他按 4 字符 ≈ 1 token 估算；同时记账「省下的」和「纸条花掉的」，界面显示**净值**；可选把跨会话总账落盘（`statsFile`）。

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
    enabled: true            # 总开关；关闭后所有读取原生透传
    capacity: 32             # 文件身份缓存容量（挂载中文件不受淘汰影响）
    ttlMs: 300000            # 缓存安全阀：同 stat 内容被改的兜底重读间隔
    maxPinnedFiles: 256      # 单个会话最多钉住多少个挂载文件
    minSavedTokens: 16       # 去重至少省这么多 token 才拦截，低于就原生透传
    maxFingerprintBytes: 1000000   # 超过此大小的文件不留行级底稿（改动时整本重挂）
    maxManagedBytes: 16777216      # 超过此大小的文件不接管，原样放行
    excludeGlobs: ['**/node_modules/**']  # 这些路径永远原样放行
    statsFile: ./dsh-file-mount-stats.json  # 可选：跨会话总账落盘路径
```

## 工作原理

插件挂在 `tools/post-execute` 拦截面，按工具名分流：

1. **read**：以 canonical value（path/offset/lines/totalLines）为准确定本次窗口；经 stat 校验式缓存（mtime+size 快路径 + sha256）核实磁盘身份后三分支决策：完全覆盖 → 结果换成去重 marker（同一个文件在两次真实消息之间只发第一条去重纸条，重复去重静默合并节省）；部分覆盖 → 短 marker + 注入缺失区间；hash 变化 → 拿行级底稿做 diff，**只补改动的行**（没动的行号平移），没底稿或改动过大则整本重挂。
2. **write**：AI 写完整文件，整本书标记为「已知道」，回头读直接免单；缓存指纹同时作废。
3. **edit**：只作废缓存指纹，下一次读走行级 diff 补发。
4. 挂载状态结构化写入注入消息的 source（标准 `user/message` 事件），恢复重放与浏览器折叠共用同一载体、同一套合并规则（`mount-source.ts`）。
5. 压缩感知：识别 DSH 标准压缩 checkpoint（source `{kind:'plugin', plugin:'compact'}` 的 `sourceEventSeqs`），被 shadow 的挂载消息不再计入账本。
6. 模型可调用 `file_mount_forget` 工具主动作废某个文件的账（强制重读）。

路径身份：绝对路径 + `realpath`（软链接统一到真实文件）+ 大小写折叠（按文件系统实测，Windows/Mac 默认折叠）。

## 已知限制

- compaction 后「已挂载」保证失效：被压缩掉的挂载内容离开模型上下文，插件靠 checkpoint 的 `sourceEventSeqs` 识别并跳过，下一次读取重新锚定。
- 增量 / 去重 / 重挂载替换了结果文本，UI 的 read 卡片降级为通用卡片（canonical value 完整保留）。
- 依赖 read / write / edit 工具 canonical value 的结构；结构变化时守卫失效并原生透传（集成测试锁定）。
- 超过 `maxManagedBytes` 的文件与 `excludeGlobs` 命中的路径不接管，原样放行（不做抽检：抽检有「改了没看出来」的风险）。
- 自定义会话事件类型在 rc.6 无法安全持久化，故账本载体选用标准事件上的结构化 source。
- 仪表盘「点行跳回聊天」、跨会话总账的界面展示、「文件已变」实时提示暂缓（浏览器端没有对应通道）。

## 常见问题

- **为什么读文件时 UI 的 read 卡片变成通用卡片？** 插件在 post-execute 替换了模型可见的结果文本（去重 marker / 增量块）；canonical value 原样保留，但卡片按结果文本渲染，所以降级为通用卡片。
- **怎么让插件少管一些文件？** `excludeGlobs` 配排除名单（如 `**/node_modules/**`），`maxManagedBytes` 配大文件上限；名单外/超大文件原样放行。
- **省的数字准吗？** 是估算：中文 1 字 ≈ 1 token，其他 4 字符 ≈ 1 token；界面显示净值（省下的 − 纸条花掉的），并按每百万 token ≈ ¥1 粗略折算人民币。
- **模型想强制重读一个文件？** 调 `file_mount_forget` 工具作废该文件的账，下次读整本重发。
- **跨会话统计怎么看？** 配置 `statsFile` 后自动累计到该文件，可通过 `fileMount.stats()` 读取；界面展示暂缓。

## 开发

```sh
pnpm install
pnpm test        # vitest（133 用例：单元 + 真实 read/write 循环集成 + 持久化往返 + 压缩感知 + 客户端组件）
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc + tsdown（lib/index.js / lib/client.js）
```

**升级 DSH 后先跑一遍测试**：压缩 checkpoint 的标记形状等耦合点由测试钉死（`tests/compaction.spec.ts`），DSH 改形状时测试会立刻报警。

依赖 DSH 0.1.0-rc.5 及以上（peer 依赖 `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis` ^4、React 18）。

## License

MIT
