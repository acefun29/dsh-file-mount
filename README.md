# dsh-file-mount

<p align="center">
  <img src="logo.png" alt="dsh-file-mount" width="420">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/DSH-%E2%89%A50.1.5--rc.1-4c6ef5.svg" alt="DSH 0.1.5-rc.1 or later">
  <img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg" alt="Node ^22.19 or >=24">
</p>

DeepSeek Harness 插件：**文件增量挂载 + 重复读取去重**。记录每个文件哪些行范围已经进入模型上下文，重复读取只补缺失的部分；文件在磁盘上变化时按行级对比只补改动的行；并用「挂载文件」仪表盘实时展示账本。

移植自 [piwpi](https://github.com/earendil-works/pi-mono) 的 context-mount 机制。

## 为什么需要它

Agent 会反复读同一个文件：刚看过一眼的实现，改两行再看一次；或者换个窗口范围再读一遍。每一次都是完整的 token 开销，而其中绝大部分内容模型**刚刚才看过**。

这个插件把「读过什么」记成账本。第二次之后的读取只把真正缺失或改动的行送进上下文，重复的部分换成一行去重说明——省下的是上下文，也是钱。

## 效果

![挂载文件仪表盘](docs/mounted-files.png)

- **模型侧**：读过的行范围不重复进上下文（去重 marker）；缺失/改动的正文写进本次 read 的工具结果（增量 / 重挂），纸条只记账本声明；文件改动后只补改动的行（行级 diff，日志追加只补新尾巴——超出行级底稿上限的大文件也走追加识别）；AI 自己写过的文件回头读直接免单（写后磁盘内容与模型写入不一致时除外，例如被 format-on-save 钩子改写）；`file_mount_forget` 工具让模型能主动强制重读。
- **界面侧**：「挂载文件」标签页是仪表盘——打开时停在顶部，**净节省与路径搜索固定在顶栏**，文件列表单独滚动；每个文件行可展开成**文件段**列表，每段带**新鲜度色带**（绿=新鲜 / 黄=一般 / 橙=接近过期 / 红=已过期 / 灰=未知）和**过期次数**；另有**覆盖图**（色块标出已挂载行在文件中的位置）、搜索、排序、净节省与人民币折算；对话区有上下文注入折叠行，「文件已变更」时行上有角标。
- **节省统计**：中文按 1 字 ≈ 1 token、其他按 4 字符 ≈ 1 token 估算；同时记账「省下的」和「插件开销」（状态通知、marker、过期重发正文），界面显示**净值**（为负时按 0 显示）；可选把跨会话总账落盘（`statsFile`）。

## 安装

一个包两面：`dsh.bundle.patch` 挂载宿主插件行，`dsh.client` manifest 让 Web 端扫描出浏览器半部。装进 profile 后**必须重启 harness**（刷新页面不够）。需要本机有 **pnpm**（`dsh plugin` 转调它）和 Node `^22.19 || >=24`。

### 快速开始（推荐）

```sh
npx --yes @deepseek-ai/dsh plugin --profile web add https://github.com/acefun29/dsh-file-mount/releases/latest/download/dsh-file-mount.tgz
npx --yes @deepseek-ai/dsh --profile web
```

已有全局 `dsh` 时，第一行换成 `dsh plugin --profile web add <同一个地址>`。装的是预构建包：不走 npm，也不需要 `allowBuilds`。

若 `npx @deepseek-ai/dsh` 长时间没输出，多半在拉 CLI（首次要下整棵依赖树），等它结束即可。

### 从本仓库源码安装

```sh
pnpm dsh:install
```

安装器会构建、打包 tarball，再用 `file:E:/...tgz` 交给 pnpm。

> **Windows 注意**：不要对目录路径用 `dsh plugin add .` 或 `file:E:\...`（反斜杠）。pnpm 会把盘符拼进 profile 目录（`profile\E:\...`），插件装上但不激活。安装器已经处理了这个坑。

### 手动装本地 tarball

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

不要用 `github:acefun29/dsh-file-mount` 装源码：仓库不含 `lib/`，包也已去掉 `prepare`。请用上面的 Release 或安装器。

## 配置

在 profile 的插件行里写 `config`，例如：

```yaml
- id: file-mount
  name: dsh-file-mount
  config:
    excludeGlobs: ['**/node_modules/**']
    statsFile: ./dsh-file-mount-stats.json
```

全部键（含默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后所有读取原生透传 |
| `capacity` | `32` | 文件身份缓存容量（挂载中的文件被钉住，不受淘汰影响） |
| `ttlMs` | `300000` | 缓存安全阀：同一 stat 内容被改的兜底重读间隔 |
| `maxPinnedFiles` | `256` | 单个会话最多钉住多少个挂载文件 |
| `minSavedTokens` | `16` | 去重/增量的净收益低于此值则原生透传且不写账本（也不计入安全阀次数） |
| `maxFingerprintBytes` | `1000000` | 超过此大小的文件不留行级底稿（改动时先识别纯追加只补尾巴，否则整本重挂） |
| `maxManagedBytes` | `16777216` | 超过此大小的文件不接管，原样放行 |
| `excludeGlobs` | `[]` | 命中的路径永远原样放行 |
| `statsFile` | 无 | 可选：跨会话总账落盘路径 |
| `freshnessEnabled` | `true` | 新鲜度总开关 |
| `freshnessThreshold` | `0.6` | 新鲜度分数低于此值判为过期 |
| `safeRatio` | `0.95` | 窗口压力为 0 的阈值比例（`Lsafe = safeRatio × W`） |
| `safeTokens` | 无 | 直接给 `Lsafe` 绝对值；设置后优先于 `safeRatio` |
| `pinAfter` | `1` | 过期几次后钉住（钉住的段不再被摘除） |
| `contextWindow` | `128000` | 会话未报告窗口时的默认窗口 `W` |
| `resendBudget` | 无 | 大于此 token 的段本轮不摘除 |
| `valveReads` | `2` | 重读安全阀：连续拦截达到此次数触发原生透传重读（`0` = 关闭） |

## 工作原理

插件挂在 `tools/post-execute` 拦截面，按工具名分流：

1. **read**：以 canonical value（path/offset/lines/totalLines）为准确定本次窗口；经 stat 校验式缓存（mtime+size 快路径 + sha256）核实磁盘身份后三分支决策：完全覆盖 → 结果换成去重 marker（同一个文件在两次真实消息之间只发第一条去重纸条，重复去重静默合并节省）；部分覆盖 / hash 变化 → **缺失或改动的正文写进本次 read 的工具结果**（每行带 `N: ` 行号，与原生 read 对齐；`cancel` 清 inbox 最多丢掉账本纸条，下次当没挂过再发），纸条只留 head-only 账本声明；hash 变化时拿行级底稿做 diff，**只补改动的行**（没动的行号平移；中段过大时用唯一行锚点切分 LCS）；没底稿的超大文件先识别纯追加（前缀哈希匹配则旧坐标恒等、只补新尾巴，旧末行无换行符被续写时该行一并重发），都不行才整本重挂。首次挂载仍保留原生 read 正文 + head-only 纸条。行级底稿的切分严格镜像 read 工具（含 UTF-8 BOM 剥除与 CRLF 折叠），指纹是仅存在内存中的 53 位快速哈希（不进协议、不落盘）。
2. **write**：AI 写完整文件，整本书标记为「已知道」，回头读直接免单；缓存指纹同时作废。 write 的 canonical value 带写入内容（`after`）时，会先与磁盘逐行指纹比对：**不一致（比如 format-on-save 钩子改写了文件）则不免单、不记账**，下次读按新文件重新锚定——模型没见过的内容不会被藏起来。
3. **edit**：标记缓存失效但保留行指纹底稿，下一次读必重读盘并走行级 diff，只补改动行。
4. 挂载状态结构化写入注入消息的 source（标准 `user/message` 事件），恢复重放与浏览器折叠共用同一载体、同一套合并规则（`mount-source.ts`）。
5. 压缩感知：识别 DSH 标准压缩 checkpoint（source `{kind:'plugin', plugin:'compact'}` 的 `sourceEventSeqs`），被 shadow 的挂载消息不再计入账本。
6. 模型可调用 `file_mount_forget` 工具主动作废某个文件的账（强制重读）。去重 marker 会提示：上文找不到内容时，先 forget 再 read。
7. **新鲜度**：挂载段记录载体消息的 `seq`，按它在当前上下文中的位置判断是否还适合去重。接近窗口上限时，越靠前的内容越容易被摘账，下次读取会重发；过期一次后钉住。压缩才会真正把内容移出上下文。另有重读安全阀（连续全覆盖去重达到次数后放行原生 read）。新鲜度不提供界面调节。

**路径身份**：账本用绝对路径 + `realpath`（软链接统一到真实文件）+ 大小写折叠（按文件系统实测，Windows/Mac 默认折叠）。模型可见的纸条 head 用相对工作目录的路径（正斜杠），工作目录取自会话 `header.cwd`，没有则用 `dsh-fs-local` 的 `cwd`。

## 兼容性

| 插件版本 | DSH |
| --- | --- |
| `main`（未发布） | `0.1.5-rc.1` 及以上，包括 `0.1.7` 的会话格式 v4（在 `0.1.7-rc.2` 上实测） |
| `0.5.1`–`0.6.0` | `0.1.5-rc.1` 及以上（在 `0.1.5-rc.2` 上实测） |
| `≤0.5.0` | `0.1.0-rc.5` 时代的 DSH；`Session.events` 被移除（0.1.2-alpha.4）之后不再适用 |

插件同时对接两侧契约：宿主侧的 `tools/post-execute` 拦截面与 read/write/edit 的 canonical value；浏览器侧的插槽（`conversation.view`）与会话快照布局。

**升级 DSH 后先跑一遍测试**。压缩 checkpoint 形状、工具结果形状、客户端快照布局这几处耦合点都由测试钉死（`pnpm test`），DSH 改形状时会立刻报警——真机上「页面空白」这类只改语义不改名字的变更，更是只有实跑才能发现。

## 已知限制

- 压缩后「已挂载」保证失效：被压缩掉的挂载内容离开模型上下文，插件靠 checkpoint 的 `sourceEventSeqs` 识别并跳过，下一次读取重新锚定。
- 增量 / 去重 / 重挂载替换了结果文本，UI 的 read 卡片降级为通用卡片（canonical value 完整保留）。
- 依赖 read / write / edit 工具 canonical value 的结构；结构变化时守卫失效并原生透传（集成测试锁定）。
- 超过 `maxManagedBytes` 的文件与 `excludeGlobs` 命中的路径不接管，原样放行（不做抽检：抽检有「改了没看出来」的风险）。
- 新鲜度是启发式：段过期不代表内容被移出上下文（只有压缩才会），而是「注意力已衰减、模型基本看不见」，故过期重发是故意的 token 开销；无 usage 数据的会话显示灰色「未知」，不判过期。
- 浏览器会话是分页历史窗口（默认尾页 50 条消息，上滚聊天才加载更早），仪表盘折叠跨快照累积，挂载消息滚出窗口后文件行仍保留；被压缩 shadow 的旧挂载在宿主侧已摘账，但浏览器端看不到 shadow 清单，行会保留到下一次该文件重挂。

### 暂缓 / 可做的下一步

- 仪表盘「点行跳回聊天」、跨会话总账的界面展示、「文件已变」实时提示此前因为浏览器端没有对应通道而搁置；DSH 0.1.5 起插件可经 `sidebar.panellist` / `main` 注册全局面板，跨会话视图有望解锁。
- 自定义会话事件类型在 rc.6 无法安全持久化——这是账本载体选用标准事件上结构化 source 的历史原因；Session V3 下该载体经持久化往返与恢复重放测试验证仍然成立。

## 常见问题

- **为什么读文件时 UI 的 read 卡片变成通用卡片？** 插件在 post-execute 替换了模型可见的结果文本（去重 marker / 增量或重挂正文）；canonical value 原样保留，但卡片按结果文本渲染，所以降级为通用卡片。
- **怎么让插件少管一些文件？** `excludeGlobs` 配排除名单（如 `**/node_modules/**`），`maxManagedBytes` 配大文件上限；名单外/超大文件原样放行。
- **省的数字准吗？** 是估算：中文 1 字 ≈ 1 token，其他 4 字符 ≈ 1 token；界面显示净值（省下的 − 插件开销，开销含状态通知、去重/重挂 marker 与过期重发的正文，为负时显示 0），并按每百万 token ≈ ¥1 粗略折算人民币。
- **模型想强制重读一个文件？** 调 `file_mount_forget` 工具作废该文件的账，下次读整本重发。去重结果里也会写明：上文找不到就先 forget 再 read。
- **跨会话统计怎么看？** 配置 `statsFile` 后自动累计到该文件，可通过 `fileMount.stats()` 读取（界面展示暂缓）。
- **装上了但没有「挂载文件」标签？** 目录安装在 Windows 上会链到错误路径，插件不会进 `dsh.profile.bundles`。改用 Release 包或 `pnpm dsh:install`，然后重启 harness。
- **`npx @deepseek-ai/dsh plugin add …` 一直没输出？** npx 在拉完整 CLI 包，可能要好几分钟。安装请用 GitHub Release 的 `dsh-file-mount.tgz` 地址；本仓库开发用 `pnpm dsh:install`。

## 开发

```sh
pnpm install
pnpm test        # vitest（214 用例：单元 + 真实 read/write 循环集成 + 持久化往返 + 压缩感知 + 新鲜度 + 客户端组件 + 安装契约）
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc + tsdown（lib/index.js / lib/client.js）
pnpm dsh:install # 打包 tarball 并装进本机 web profile（Windows 可用；源码比产物新时会自动重建）
```

打 GitHub Release：打 `v*` 标签并 push，CI 会上传稳定文件名 `dsh-file-mount.tgz`（`releases/latest/download/dsh-file-mount.tgz`）。暂不发布 npm。

## License

MIT
