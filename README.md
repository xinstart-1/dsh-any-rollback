# dsh-rollback · dsh-rewind-plugin 0.19.1 的产物追踪补丁版

> `dsh-rollback` 是 [`dsh-rewind-plugin`](https://github.com/SiriLee/dsh-rewind) **0.19.1** 的非官方重打包，
> 加了「命令产物追踪」补丁，供 DSH harness **0.2.1 线**使用。
> 它是**独立包**（不是顶着上游名字的替换品），与上游包可以并存安装。
> 与上游作者无关，MIT 许可（与上游一致）——见[许可](#许可)。
>
> English version: [README.en.md](README.en.md)

## 为什么需要它

上游 `main`（0.20.0-alpha.1）要求 DSH `>=0.2.2-alpha.2`，在 0.2.1 线上会被加载阶段直接拒绝。
0.19.1 是能在 0.2.1 线上跑通的最后一个版本 —— 但它不追踪命令产出的文件，而这恰恰是 agent 干活时最常见的产物。

| 版本 | `engines.dsh` | 能否在 DSH 0.2.1-rc.5 上跑 |
| --- | --- | --- |
| `0.19.1`（本仓库，已打补丁） | `>=0.2.1-rc.1 <0.3.0-0` | 能 |
| `0.20.0-alpha.1`（上游） | `>=0.2.2-alpha.2 <0.3.0-0` | 不能，加载即被拒 |

harness 升到 0.2.2 线后请换回上游；本仓库只是过渡方案。

## 补丁做了什么

**缺口。** 上游只追踪 `write` / `edit` 两个写类工具碰过的文件 —— 文件要被这两个工具处理过一次，才会进入
可还原清单。`node render.mjs`、`ffmpeg`、构建或数据脚本产出的文件永远进不了这份清单，回退时完全不动：

- 目标时刻**还不存在**的文件（命令新建的产物）会留在磁盘上；
- 字节**变过**的文件保留新内容，而回退报告「无可还原变更」。

这类文件通常也远超 8 MiB 的 `maxFileBytes` 上限，连上限判断都不会走到。
上游在 [`docs/compat/tracking-boundary.md`](https://github.com/SiriLee/dsh-rewind/blob/main/docs/compat/tracking-boundary.md)
的 *Limitation 1* 里明确记录并**有意接受**了这个边界。

**补丁的做法。** 每个回合边界给工作区写一份清单（`路径 → size + mtime + sha256`），只对**发生变化**的条目
缓存内容（按摘要去重，重复渲染出相同字节不额外占空间）。回退时按目标时刻的状态分三种处理：

| 目标时刻 | 现在 | 动作 |
| --- | --- | --- |
| 存在，内容已缓存 | 不同 / 缺失 | 还原缓存的字节 |
| 不存在 | 存在（命令新建的产物） | 移入 `quarantine/`，去向记入 `index.json` |
| 存在，内容未缓存（过大 / 未缓存） | 不同 / 缺失 | 移入 `quarantine/`，并提示「需要时重新生成」 |

隔离区**只移动、从不删除**：字节保留在快照根目录下，并在 `index.json` 里记录来源，可人工取回。

### 配置项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `artifactTrackingEnabled` | `true` | 总开关 |
| `artifactMaxFileBytes` | `67108864`（64 MiB） | 单文件缓存上限，与 `maxFileBytes` 独立 |
| `artifactBaselineContent` | `false` | 同时缓存首次观测到的内容（可还原插件从未见过的历史内容） |
| `artifactExclude` | `node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target` | 跳过的目录名 |
| `artifactKeepManifests` | `20` | 每会话保留的清单份数 |

### 落盘位置

```
<snapshotDir>/<sessionId>/artifacts/
  manifests/<seq>.json      # 每个回合边界一份清单
  quarantine/               # 被移出的文件
  quarantine/index.json     # 每个文件的原路径
```

`<snapshotDir>` 就是插件原有的 `snapshotDir`（默认 `~/.dsh/rewind-snapshots/`），
清空它仍然会把补丁存的东西一起清掉。

## 安装

### A. 用本仓库 Release 的 tarball（推荐）

profile 的 `package.json` 里加依赖：

```json
"dependencies": {
  "dsh-rollback": "https://github.com/xinstart-1/dsh-rollback/releases/download/v0.19.1-rb.1/dsh-rollback-0.19.1.tgz"
}
```

然后安装并重启 DSH：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

同时确认 `dsh-rollback` 在该 profile 的 `dsh.profile.bundles` 数组里 —— **那个数组才是真正加载插件的开关**。
如果那里还留着 `dsh-rewind-plugin`，把依赖和 bundles 里的旧行一起删掉：两份同时挂着会各渲染一个 ↶ 按钮。

### B. 从克隆目录装

```json
"dsh-rollback": "file:C:/path/to/dsh-rollback/dist/dsh-rollback-0.19.1.tgz"
```

### C. 给已装的官方 0.19.1 原地打补丁 —— 改名后不再支持

DSH 用 `require.resolve('<包名>/package.json')` 定位客户端半边，`node_modules` 下的目录名必须等于包名，
所以叫 `dsh-rollback` 的包不能住在 `dsh-rewind-plugin` 目录里。请用 A 或 B 安装；
已装的 `dsh-rollback` 目录可以用 `scripts/refresh.ps1` 重新同步。

## 校验

```powershell
node scripts\verify.mjs                  # 默认查桌面 profile
node scripts\verify.mjs "<包目录>"        # 查任意解包目录
```

期望的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `lib/index.js` | `cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3` |
| `lib/artifact-track.js` | `03e8ddab92765bf8a53522495b0b657235c327cb94b01d88ff7fe46bd9ba7b6c` |
| `lib/client.js` | `5d29b0fa28577bcf8d2c0425029016f18a63efcdfbe138ac0b6d07f21c766461` |
| `dist/dsh-rollback-0.19.1.tgz` | `0e0bd8f9ad4a79aeb382b15fa29e8dac27b95552b6d17249dea5c931e74cb46f` |

运行期验证：重启后跑一个回合，确认
`~\.dsh\rewind-snapshots\<会话ID>\artifacts\manifests\` 出现清单文件，同时 ↶ 按钮应已恢复。

## 回滚 / 升级

| 目的 | 做法 |
| --- | --- |
| 回到干净的上游插件 | 依赖改成 `"dsh-rewind-plugin": "0.19.1"`（或 harness 允许后的 `"0.20.0-alpha.1"`），从依赖和 bundles 里删掉 `dsh-rollback`，再装 |
| 只清产物数据、保留原有快照 | 删除 `<snapshotDir>/<会话ID>/artifacts/` |
| harness 升到 0.2.2 后换上游 0.20 | 上游**不含**本补丁，0.20 也没有产物追踪 |

## 与官方 0.19.1 的差异

| 路径 | 改动 |
| --- | --- |
| `lib/index.js` | 打补丁：`ArtifactTracker` 导入、5 个配置项、`turn/end` 钩子、`previewImpact` 合并、`executeRewind` 还原/隔离、`apply()` 接线；完整 diff 见 [`patch/artifact-patch.diff`](patch/artifact-patch.diff)（10 个 hunk） |
| `lib/artifact-track.js` | 新增模块（16.9 KB），源码同时保留在 [`patch/artifact-track.js`](patch/artifact-track.js) |
| `package.json` | 包名改为 `dsh-rollback`；去掉 `scripts.prepare`，避免安装时尝试跑一个没有随包发布的构建 |
| `cordis.patch.yml`、`lib/client.js` | 加载器行与客户端/设置项身份常量随包名一起改（见下） |

包名是 `dsh-rollback`，且必须在**四处**同时一致：`package.json` 的 `name`、`cordis.patch.yml` 的加载器行
（`id` + `name`）、`lib/client.js` 里 `__ModuleLoader__.load({ id })` 的注册 id，以及编译后的
`PLUGIN_PACKAGE` / `SETTINGS_ENTRY_ID`。DSH 用这一个名字做客户端 graph row、`plugins.bundle.config` 槽位和
设置项 id 的键 —— 四处里任何一处漂移，↶ 按钮和设置卡都会**静默消失**。

**内部标识**则刻意保留上游名字，旧数据继续可读：会话标记类型 `dsh-rewind`、快照目录 `rewind-snapshots`、
RPC 频道 `/dsh-rewind`、CSS 类名前缀 `dsh-rewind-`。

改名会丢掉旧的设置文档：DSH 按 entry id 存配置，原来给 `dsh-rewind-plugin` 存的那份（备份开关、清理策略）
不会被改名后的 entry 读取。到插件页重新设一次即可；已存的快照本身不受影响。

## 注意

- 0.19.1 是旧线，上游不保留跨版本兼容，本 fork 也不会跟进后续 harness 变化。
- 补丁打在**构建产物**层（上游源码里没有它）。从 npm registry 重装上游包拿回的还是没有补丁的版本 ——
  用本仓库的 tarball 重装，或对已装的 `dsh-rollback` 目录跑 `scripts/refresh.ps1`。
- 内容缓存是明文副本，落在快照根目录，与插件自身备份的信任边界一致，但磁盘占用更大；
  用 `artifactMaxFileBytes` / `artifactExclude` 约束它。
- 上游把这个追踪边界当作有意的设计取舍，本补丁因此可能永远不会被上游接受，只作为本地绕行方案维护。

## 仓库结构

```
dist/     可安装的 tarball（Release 附件）
package/  同一个包的解包版，便于逐文件审阅与对比
patch/    产物级 diff + 新增模块源码
scripts/  verify.mjs（完整性校验）、refresh.ps1（重新同步已装副本）
```

## 许可

MIT。上游插件 © SiriLee（[SiriLee/dsh-rewind](https://github.com/SiriLee/dsh-rewind)）；
补丁与本打包同样以 MIT 发布。见 [LICENSE](LICENSE)。
