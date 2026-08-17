# dsh-file-mount

<p align="center">
  <img src="logo.png" alt="dsh-file-mount" width="420">
</p>

DeepSeek Harness 插件：**文件增量挂载 + 重复读取去重**。记录每个文件哪些行范围已经进入模型上下文，重复读取只补缺失部分；文件在磁盘上变化时按行级对比只补改动的行；并提供「挂载文件」仪表盘实时展示账本。

移植自 [piwpi](https://github.com/earendil-works/pi-mono) 的 context-mount 机制。

## 效果

- **模型侧**：读过的行范围不重复进上下文（去重 marker）；缺失/改动的正文写进本次 read 的工具结果（增量 / 重挂），纸条只记账本声明；文件改动后只补改动的行（行级 diff，日志追加只补新尾巴）；AI 自己写过的文件回头读直接免单；`file_mount_forget` 工具让模型能主动强制重读。
- **界面侧**：「挂载文件」标签页是仪表盘——打开时停在顶部，**净节省与路径搜索固定在顶栏**，文件列表单独滚动；每个文件行可展开成**文件段**列表，每段带**新鲜度色带**（绿=新鲜/黄=一般/橙=接近过期/红=已过期/灰=未知）和**过期次数**；另有**覆盖图**（色块标出已挂载行在文件中的位置）、搜索、排序、净节省与人民币折算；对话区有上下文注入折叠行，「文件已变更」时行上有角标。
- **节省统计**：中文按 1 字 ≈ 1 token、其他按 4 字符 ≈ 1 token 估算；同时记账「省下的」和「纸条花掉的」，界面显示**净值**（为负时按 0 显示）；可选把跨会话总账落盘（`statsFile`）。

## 安装

一个包两面：`dsh.bundle.patch` 挂载宿主插件行，`dsh.client` manifest 让 Web 端扫描出浏览器半部。装进 profile 后**必须重启 harness**（刷新页面不够）。需要本机有 **pnpm**（`dsh plugin` 转调它）和 Node `^22.19 || >=24`。

### 1. GitHub Release（推荐）

```sh
npx --yes @deepseek-ai/dsh plugin --profile web add https://github.com/acefun29/dsh-file-mount/releases/latest/download/dsh-file-mount.tgz
npx --yes @deepseek-ai/dsh --profile web
```

已有全局 `dsh` 时把第一行换成 `dsh plugin --profile web add https://github.com/acefun29/dsh-file-mount/releases/latest/download/dsh-file-mount.tgz`。装的是预构建包，无需 `allowBuilds`，也不走 npm。

若 `npx @deepseek-ai/dsh` 长时间没输出，多半在拉 CLI；等它结束，或先用本机已经跑过的 DSH（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh`）。

### 2. 本仓库开发版

```sh
pnpm dsh:install
```

安装器会打包 tarball，并用 `file:E:/...tgz` 交给 pnpm。Windows 上不要对目录路径用 `dsh plugin add .` 或 `file:E:\...`（pnpm 会把盘符拼进 profile 目录，插件装上但不激活）。

### 3. 本地 tarball

```sh
pnpm run build
npm pack --ignore-scripts
dsh plugin --profile web add file:$(pwd)/dsh-file-mount-$(node -p "require('./package.json').version").tgz
```

Windows PowerShell：

```powershell
pnpm run build
npm pack --ignore-scripts
$Tgz = ((Get-Location).Path -replace '\\','/') + "/dsh-file-mount-$((Get-Content package.json -Raw | ConvertFrom-Json).version).tgz"
npx --yes @deepseek-ai/dsh plugin --profile web add "file:$Tgz"
```

不要用 `github:acefun29/dsh-file-mount` 装源码：仓库不含 `lib/`，且包已去掉 `prepare`。请用上面的 Release / 安装器。

然后启动：`npx @deepseek-ai/dsh --profile web`。

## 配置

```yaml
- id: file-mount
  name: dsh-file-mount
  config:
    enabled: true            # 总开关；关闭后所有读取原生透传
    capacity: 32             # 文件身份缓存容量（挂载中文件不受淘汰影响）
    ttlMs: 300000            # 缓存安全阀：同 stat 内容被改的兜底重读间隔
    maxPinnedFiles: 256      # 单个会话最多钉住多少个挂载文件
    minSavedTokens: 16       # 去重/增量净收益低于此值则原生透传且不写账本（也不计入安全阀次数）
    maxFingerprintBytes: 1000000   # 超过此大小的文件不留行级底稿（改动时整本重挂）
    maxManagedBytes: 16777216      # 超过此大小的文件不接管，原样放行
    excludeGlobs: ['**/node_modules/**']  # 这些路径永远原样放行
    statsFile: ./dsh-file-mount-stats.json  # 可选：跨会话总账落盘路径
    freshnessEnabled: true        # 新鲜度：默认开
    pinAfter: 1                   # 过期一次后钉住，该段最多只被重发一次
    contextWindow: 128000         # 会话未报告窗口时的默认 W
    # resendBudget: 8000          # 可选：大于此 token 的段本轮不摘除
    valveReads: 2                 # 重读安全阀：连续拦截达到此次数触发原生透传重读（0=关闭）

## 工作原理

插件挂在 `tools/post-execute` 拦截面，按工具名分流：

1. **read**：以 canonical value（path/offset/lines/totalLines）为准确定本次窗口；经 stat 校验式缓存（mtime+size 快路径 + sha256）核实磁盘身份后三分支决策：完全覆盖 → 结果换成去重 marker（同一个文件在两次真实消息之间只发第一条去重纸条，重复去重静默合并节省）；部分覆盖 / hash 变化 → **缺失或改动的正文写进本次 read 的工具结果**（每行带 `N: ` 行号，与原生 read 对齐；`cancel` 清 inbox 最多丢掉账本纸条，下次当没挂过再发），纸条只留 head-only 账本声明；hash 变化时拿行级底稿做 diff，**只补改动的行**（没动的行号平移；中段过大时用唯一行锚点切分 LCS），没底稿或改动过大则整本重挂。首次挂载仍保留原生 read 正文 + head-only 纸条。
2. **write**：AI 写完整文件，整本书标记为「已知道」，回头读直接免单；缓存指纹同时作废。
3. **edit**：标记缓存失效但保留行指纹底稿，下一次读必重读盘并走行级 diff，只补改动行。
4. 挂载状态结构化写入注入消息的 source（标准 `user/message` 事件），恢复重放与浏览器折叠共用同一载体、同一套合并规则（`mount-source.ts`）。
5. 压缩感知：识别 DSH 标准压缩 checkpoint（source `{kind:'plugin', plugin:'compact'}` 的 `sourceEventSeqs`），被 shadow 的挂载消息不再计入账本。
6. 模型可调用 `file_mount_forget` 工具主动作废某个文件的账（强制重读）。去重 marker 会提示：上文找不到内容时，先 forget 再 read。
7. **新鲜度**：挂载段记录载体消息的 `seq`，按它在当前上下文中的位置判断是否还适合去重。接近窗口上限时，越靠前的内容越容易被摘账，下次读取会重发；过期一次后钉住。压缩才会真正把内容移出上下文。另有重读安全阀（连续全覆盖去重达到次数后放行原生 read）。新鲜度不提供界面调节。
路径身份：账本用绝对路径 + `realpath`（软链接统一到真实文件）+ 大小写折叠（按文件系统实测，Windows/Mac 默认折叠）。模型可见的纸条 head 用相对工作目录的路径（正斜杠），工作目录取自会话 `header.cwd`，没有则用 `dsh-fs-local` 的 `cwd`。

## 已知限制

- compaction 后「已挂载」保证失效：被压缩掉的挂载内容离开模型上下文，插件靠 checkpoint 的 `sourceEventSeqs` 识别并跳过，下一次读取重新锚定。
- 增量 / 去重 / 重挂载替换了结果文本，UI 的 read 卡片降级为通用卡片（canonical value 完整保留）。
- 依赖 read / write / edit 工具 canonical value 的结构；结构变化时守卫失效并原生透传（集成测试锁定）。
- 超过 `maxManagedBytes` 的文件与 `excludeGlobs` 命中的路径不接管，原样放行（不做抽检：抽检有「改了没看出来」的风险）。
- 自定义会话事件类型在 rc.6 无法安全持久化，故账本载体选用标准事件上的结构化 source。
- 新鲜度是启发式：段过期不代表内容被移出上下文（只有压缩才会），而是「注意力已衰减、模型基本看不见」，故过期重发是故意的 token 开销；无 usage 数据的会话（如某些适配器）显示灰色「未知」，不判过期。
- 浏览器会话是分页历史窗口（默认尾页 50 条消息，上滚聊天才加载更早），仪表盘折叠跨快照累积，挂载消息滚出窗口后文件行仍保留；被压缩 shadow 的旧挂载在宿主侧已摘账，但浏览器端看不到 shadow 清单，行会保留到下一次该文件重挂。
- 仪表盘「点行跳回聊天」、跨会话总账的界面展示、「文件已变」实时提示暂缓（浏览器端没有对应通道）。

## 常见问题

- **为什么读文件时 UI 的 read 卡片变成通用卡片？** 插件在 post-execute 替换了模型可见的结果文本（去重 marker / 增量或重挂正文）；canonical value 原样保留，但卡片按结果文本渲染，所以降级为通用卡片。
- **怎么让插件少管一些文件？** `excludeGlobs` 配排除名单（如 `**/node_modules/**`），`maxManagedBytes` 配大文件上限；名单外/超大文件原样放行。
- **省的数字准吗？** 是估算：中文 1 字 ≈ 1 token，其他 4 字符 ≈ 1 token；界面显示净值（省下的 − 纸条花掉的，为负时显示 0），并按每百万 token ≈ ¥1 粗略折算人民币。
- **模型想强制重读一个文件？** 调 `file_mount_forget` 工具作废该文件的账，下次读整本重发。去重结果也会写明：上文找不到就先 forget 再 read。
- **跨会话统计怎么看？** 配置 `statsFile` 后自动累计到该文件，可通过 `fileMount.stats()` 读取；界面展示暂缓。
- **`npx @deepseek-ai/dsh plugin add …` 一直没输出？** npx 在拉完整 CLI 包，可能要好几分钟。用户安装请用 GitHub Release 的 `dsh-file-mount.tgz` 地址；本仓库开发用 `pnpm dsh:install`。Windows 上不要 `add .`，用 `file:E:/...tgz`（正斜杠）。
- **装上了但没有「挂载文件」标签？** 目录安装在 Windows 上会链到错误路径，插件不会进 `dsh.profile.bundles`。改用 Release 包或 `pnpm dsh:install` 后重启 harness。

## 开发

```sh
pnpm install
pnpm test        # vitest（191 用例：单元 + 真实 read/write 循环集成 + 持久化往返 + 压缩感知 + 新鲜度 + 客户端组件 + 安装契约）
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc + tsdown（lib/index.js / lib/client.js）
pnpm dsh:install # 打 tarball 并装进本机 web profile（Windows 可用）
```

打 GitHub Release：打 `v*` 标签并 push，CI 会上传稳定文件名 `dsh-file-mount.tgz`（`releases/latest/download/dsh-file-mount.tgz`）。暂不发布 npm。

**升级 DSH 后先跑一遍测试**：压缩 checkpoint 的标记形状等耦合点由测试钉死（`tests/compaction.spec.ts`），DSH 改形状时测试会立刻报警。

依赖 DSH 0.1.0-rc.5 及以上（peer 依赖 `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis` ^4、React 18）。

## License

MIT