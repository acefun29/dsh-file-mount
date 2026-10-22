# DSH 0.2.1-rc.2 适配记录(插件 0.9.0)

> 2026-10-22。目标:`@deepseek-ai/dsh@0.2.1-rc.2`(npm `latest`/`next`;无 0.2.0 final,rc.2 即当前稳定标签;`alpha` 通道另到 0.2.1-alpha.5,不追)。
> 源码参照:github.com/deepseek-ai/deepseek-harness,标签 `dsh-v0.2.1-rc.2`。`@deepseek-ai/dsh-desktop@0.2.1-rc.2` 未上 npm(404),真机验证以 `dsh` CLI profile 为准。

## 1. 与 0.2.0-rc.2 的实测差异(逐项对照两个标签源码 / npm 产物)

| 项 | 0.2.0-rc.2 | 0.2.1-rc.2 | 对本插件的影响 |
| --- | --- | --- | --- |
| 兼容判定 | peerDependencies 逐包门禁 | **`engines.dsh` 单独裁决,peers 被忽略**(`dsh-app-boot` `evaluatePluginCompatibility`);仅当未声明 engines.dsh 时才看 dsh peers | 双声明(engines + peers)同步提升到 `^0.2.1-rc.2`,策略不变 |
| 平台模块表(seed words) | 9 项 | **11 项:新增 `zod`、`@tanstack/react-virtual`**(实测自 `dsh-client-web` `getStaticModules()` / `PLATFORM_MODULES`) | 冒烟 SEED_WORDS 与 `tsdown.config.ts` `PLATFORM_MODULES` 更新;本插件客户端产物仍只 `require` react / react/jsx-runtime |
| `dsh-tool-fs` 注入 | `tools`, `fs`, `systemPrompt` | 新增 **`workingDirectory`** 服务(0.2.1 新 working_directory 工具的同源服务) | 测试 harness 需先挂 `@deepseek-ai/dsh-working-directory`(`workingDirectory` 服务,其自身注入 fs/sessionProjections/systemPrompt,harness 均已具备) |
| `dsh-session-persistence-jsonl` | 默认导出插件 | **默认导出移除**,导出 `{ Config, apply, name, JsonlCompressionSchema }` | 测试改用具名 `apply`;`Context.sessionPersistence` 的类型 augmentation 移到契约包 `dsh-session-persistence`,需显式 `import type {}` 加载 |
| `parseDshClient`(dsh.client 清单校验) | 四字段(platform/inject/external/immediately) | **逐字一致** | `dsh.client` 清单不动;`manifestVersion: 1` 两版均不校验(透传) |
| 会话格式 | v4 | **仍 v4**(无 v4-to-v5 迁移包) | 账本无需迁移;`format = 4` 断言保留 |
| read / write canonical value | read `{path,offset,lines,totalLines}`;write `{path,operation,before,after}` | **不变** | 鸭子类型守卫不动 |
| `conversation.view` 焦点请求 | `ConversationViewRequest {view, focus}` + ack | **不变**(ui-conversation client 目录仅增量新增 user-text/、draft.ts) | 客户端半不动 |
| 依赖小版本 | cordis 4.0.4 / schemastery 3.18.4 | **cordis ~4.0.5 / schemastery ~3.18.5**(0.2.1 运行时范围) | peers + devDeps 提升 |
| React | ^18.2.0 | **不变** | 不动 |

release notes 层面其余对插件作者的破坏性变更(invariant 导出移除、stats 拆分 activity/usage、subpath 插件不再读独立 package.json)均与本插件无关(单包双入口、无 stats、无 invariant)。

## 2. 改动清单

- `package.json`:version 0.9.0;`engines.dsh`、12 个 `@deepseek-ai/dsh*` peers、全部 dsh devDeps → `^0.2.1-rc.2`;cordis → `^4.0.5`;schemastery → `^3.18.5`;devDeps 新增 `@deepseek-ai/dsh-working-directory@^0.2.1-rc.2`(测试 harness 用)。
- `pnpm-lock.yaml`:全量重生成(`auto-install-peers=true` 保持)。
- `src/index.ts`:`DSH_COMPAT_VERSION = '0.2.1-rc.2'`。
- `scripts/smoke-client-boot.mjs`:SEED_WORDS 换 0.2.1 实测 11 项表。
- `tsdown.config.ts`:`PLATFORM_MODULES` 清掉 0.1.x 遗留名(`dsh-client-web-react` / `ui-attachment` / `schema-form`),对齐 0.2.1 实测表。
- `tests/harness.ts`:LocalFileSystem 之后、toolFs 之前挂 `WorkingDirectory`。
- `tests/integration.spec.ts`:jsonl 持久化改具名 `apply` 导入 + 显式加载契约包类型。
- `README.md` / `README.en.md`:徽章与兼容表加 0.9.0 行。

宿主半与客户端半的**业务代码零改动**——0.2.1 没有触碰本插件依赖的任何运行时契约形状。

## 3. 验证(全部通过)

1. `pnpm test`:**242 / 242**(含真实 dsh 包组装的 agent loop 集成 / 对抗 / 降级 / 源类型套件)。
2. `pnpm typecheck`:干净。
3. `pnpm build` + `pnpm run smoke:client`:产物级冒烟 6/6(冻结模块表加载、槽注册、真实 React 渲染、焦点 ack;越表 require 即报错)。
4. 真机 profile 实装:`dsh plugin --profile fm-021 add <0.9.0 tgz>`(CLI 0.2.1-rc.2)成功,`--dump-config` 组合树中 `file-mount` 行启用、无 disabled。
5. 用 DSH 自己的裁决函数复核:在 runtime `0.2.1-rc.2` 上 `evaluatePluginCompatibility(manifest)` 返回无问题。

## 4. 备注

- **预发布参与范围匹配**:0.2.1 的 semver 判定里 prerelease 参与普通范围,因此旧的 `^0.2.0-rc.2` 在 0.2.1 运行时上其实也会被放行(实测复核过)。本次提升的意义是**钉住已验证基线**并让漂移告警携带正确版本号,不是硬门槛差异。
- desktop 壳 0.2.1 尚未发布到 npm;桌面用户在壳更新前继续用 0.8.1 release(GitHub Releases 按标签保留历史)。
- 冒烟/构建的模块表来源快照存于 `.recon/probe-0.2.1/`(dsh-client-web / dsh-client-modules / dsh-app-boot / dsh-plugin-manager 四包 tarball 提取)。
