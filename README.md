# dsh-rollback

> **DSH 对话回退插件。** 回退到任意一条历史消息，并把工作区文件一起还原 ——
> 包括渲染、ffmpeg、构建脚本这类**命令产出的文件**，不只是编辑器里改过的源码。
> 不 fork 会话、不开新窗口，就在当前对话里原地回退。
>
> English version: [README.en.md](README.en.md)

## 它解决什么问题

用 AI 干活时，一个回合经常同时留下两类痕迹：对话里的消息，和工作区里的文件。想「回到那一步重来」时，
两者都得回到当时的样子才对 —— 只退对话会留下一地改了半截的文件，只退文件则对话还停在错误的上下文里。

`dsh-rollback` 把这两件事一起做：点消息上的 ↶，对话回到那条消息之前，文件也回到那一刻的状态。

| 场景 | 没有本插件 | 使用本插件 |
| --- | --- | --- |
| 生成视频的脚本跑了 3 版，想回到第 1 版 | 得手动清理 `out/` 里一堆 mp4 | 回退即还原，旧版本移入隔离区 |
| 让 AI 重构，改错了想撤回 | 对话回退后文件仍是坏的 | 对话和文件一起回到改前 |
| 多轮试错，想从某一步重来 | 开新会话，丢失上下文 | 原地回退，同窗口继续 |

## 核心功能

### 1. 按消息回退对话

每条用户消息旁有 ↶ 按钮。点它，这条消息之后的内容从对话视图上撤下（会话日志仍只追加、不删除，可追溯），
输入框自动填回被撤回的那句话，改一改就能重新提问。

也可以直接用命令：

| 命令 | 作用 |
| --- | --- |
| `/rewind <序号>` | 回退到第 N 条用户消息之前 |
| `/rewind @<seq>` | 按会话内序号回退 |
| `/undo` | 取消上一次回退 |

### 2. 同时还原工作区文件

回退时可选择只退对话、只退文件，或两者都退。文件还原依据的是**插件自己的备份目录**，
不猜测、不推断：只写回真正备份过的内容。

### 3. 追踪命令产出的文件（本插件的重点能力）

大多数工具只备份模型调用 `write` / `edit` 改过的文件。可 AI 干活时更常见的产物是命令生成的：
`node render.mjs` 出的帧序列、`ffmpeg` 合成的视频、构建脚本写进 `dist/` 的产物、数据脚本导出的
`*.parquet`。这些文件没人「编辑」过，常规做法完全不管它们。

本插件在每个回合边界记录一份工作区清单（`路径 → 大小 + mtime + sha256`），
**只对发生变化**的文件按内容摘要缓存（相同字节重复渲染不额外占空间），回退时逐文件判断：

| 目标时刻的状态 | 现在 | 处理方式 |
| --- | --- | --- |
| 存在，内容已缓存 | 不同或已缺失 | 还原备份的字节 |
| 不存在 | 存在（命令新建的产物） | 移入隔离区，不删除 |
| 存在，内容未缓存（超大或未缓存） | 不同或缺失 | 移入隔离区，并提示「需要时重新生成」 |

**隔离区只移动、从不删除**：文件保留在磁盘上，去向记在 `index.json` 里，随时可人工取回。
误删一个渲染了两小时的视频是不可接受的，所以这里宁可多占空间。

### 4. 快照自动清理

备份会占空间，插件按策略自动清理：可设置开关、闲置天数上限，也可随时查看状态或手动执行。

| 命令 | 作用 |
| --- | --- |
| `/snapshot-auto-cleanup` | 查看当前状态 |
| `/snapshot-auto-cleanup on\|off` | 启用 / 停用自动清理 |
| `/snapshot-auto-cleanup max-age <天数>` | 设置闲置天数上限 |
| `/snapshot-auto-cleanup run [-–apply]` | 预演，或真正执行清理 |
| `/snapshot-auto-cleanup run --current [--apply]` | 只清理当前会话的备份 |

### 5. 设置卡片

在 DSH 插件页有独立配置卡片，可开关文件备份、调整自动清理策略，不用改配置文件。

## 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `fileCheckpointingEnabled` | `true` | 是否记录新的文件备份 |
| `maxFileBytes` | `8388608`（8 MiB） | 单文件备份上限，`0` 表示不限制 |
| `snapshotDir` | `~/.dsh/rewind-snapshots/` | 备份存放根目录 |
| `artifactTrackingEnabled` | `true` | 是否追踪命令产出的文件 |
| `artifactMaxFileBytes` | `67108864`（64 MiB） | 命令产物单文件缓存上限，独立于 `maxFileBytes` |
| `artifactBaselineContent` | `false` | 是否缓存首次观测到的内容（更占空间，能还原插件未见过历史的大文件） |
| `artifactExclude` | `node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target` | 追踪时跳过的目录 |
| `artifactKeepManifests` | `20` | 每个会话保留的清单份数 |
| `autoCleanupEnabled` | `true` | 自动清理开关 |
| `autoCleanupMaxAgeDays` | `30` | 备份闲置多少天后可清理 |

## 数据放在哪里

```
~/.dsh/rewind-snapshots/<会话ID>/
  <消息序号>/            # 每条消息对应的文件备份
  artifacts/
    manifests/           # 每个回合边界一份工作区清单
    quarantine/          # 回退时移出的文件
    quarantine/index.json # 每个文件的原路径
```

备份目录与工作区分离（不是工作区的子目录）。删掉这个目录只会丢失回退能力，不会影响项目文件本身。

## 安装

### 从 Release 安装（推荐）

在 profile 的 `package.json` 中加依赖：

```json
"dependencies": {
  "dsh-rollback": "https://github.com/xinstart-1/dsh-rollback/releases/download/v0.19.1-rb.2/dsh-rollback-0.19.1.tgz"
}
```

安装并重启 DSH：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

还要确认 `dsh-rollback` 已加入该 profile 的 `dsh.profile.bundles` 数组 —— **这个数组才是真正加载插件的开关**。

### 从源码目录安装

```json
"dsh-rollback": "file:C:/path/to/dsh-rollback/dist/dsh-rollback-0.19.1.tgz"
```

## 环境要求

| 项 | 要求 |
| --- | --- |
| DSH | `>=0.2.1-rc.1 <0.3.0-0` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

## 校验安装

```powershell
node scripts\verify.mjs                  # 检查当前桌面 profile
node scripts\verify.mjs "<包目录>"        # 检查任意解包目录
```

期望的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `lib/index.js` | `cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3` |
| `lib/artifact-track.js` | `e3d909c91f25ee144d668b2841278d14fd9dfab4d625596d7fe808622a29f1e6` |
| `lib/client.js` | `5d29b0fa28577bcf8d2c0425029016f18a63efcdfbe138ac0b6d07f21c766461` |
| `dist/dsh-rollback-0.19.1.tgz` | `7a18df38e9323aec964e49b5720a08933ddb921ba12939fec64e9b13b00bb28f` |

装完**重启 DSH** 才会生效（插件宿主侧每个进程只加载一次）。重启后跑一个回合，
确认 `~\.dsh\rewind-snapshots\<会话ID>\artifacts\manifests\` 下出现清单文件，且消息旁出现 ↶ 按钮。

## 卸载

从 profile 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-rollback`，重新安装依赖即可。
备份数据不会自动删除；要彻底清理，手动删除 `~/.dsh/rewind-snapshots/`。

## 设计取舍

- **只写回真正备份过的内容。** 宁可少还原，也不用推断去覆盖文件。
- **不删除任何文件。** 回退时要移出的文件一律进隔离区。
- **会话日志只追加。** 回退只改变对话视图，历史记录永远完整可查。
- **备份目录独立于工作区。** 不会污染项目，也不会被项目里的清理脚本误删。

## 已知限制

以下是当前版本实测确认的边界，使用前请知悉。

### 1. 超过大小上限、且内容改过的文件，回退时会被移出工作区

单文件超过上限（`maxFileBytes` 或 `artifactMaxFileBytes`）时，内容不会被缓存。此时若文件内容**变化过**，
回退无法判断它「当时是什么」，当前实现会按「新建产物」处理，把它**移入隔离区** ——

- 文件不会丢失（在 `quarantine/` 下，`index.json` 记录原路径，可找回）；
- 但在回退那一刻它会从工作区消失，看起来像被删了；
- 期望的行为应该是「跳过并提示」，这一点待修。

规避：把常用的大文件目录加进 `artifactExclude`，或调高 `artifactMaxFileBytes`。

### 2. 1.5 秒内发生的「同尺寸」修改可能被漏记

判断文件是否变化用的是 `大小 + mtime`，且 mtime 有 1500 ms 容差。如果一个文件在上一份清单之后
**大小不变、且在容差窗口内被改写**，插件会沿用旧的内容摘要，导致回退还原成更早的版本。
脚本连续产出同尺寸文件（固定分辨率的帧、定长记录）最容易触发。

### 3. 内容缓存没有回收机制

清单按 `artifactKeepManifests` 裁剪，但**按内容缓存的文件从不删除**。会话越长、产物变化越多，
`artifacts/blobs/` 占用持续增长，只有删除整个会话目录才会释放。

### 4. 点目录不参与追踪

扫描时跳过所有以 `.` 开头的目录。产物若落在 `.output/`、`.cache/` 这类位置，回退不会处理。

### 5. 回退依赖已有备份

插件启用前的历史、以及关闭备份期间产生的改动没有记录，无法还原。会话被压缩（compact）之后，
早于压缩点的消息也不再出现在回退列表中。

## 仓库结构

```
dist/     可安装的 tarball（Release 附件）
lib/      宿主侧与客户端侧入口
locale/   界面文案
scripts/  verify.mjs（完整性校验）、refresh.ps1（重新同步已装副本）
```

## 许可

MIT。见 [LICENSE](LICENSE)。
