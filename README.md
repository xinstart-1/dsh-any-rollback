# dsh-any-rollback

> **DSH 对话回退插件。** 回退到任意一条历史消息，并把工作区文件一起还原 ——
> 包括渲染、ffmpeg、构建脚本这类**命令产出的文件**，不只是编辑器里改过的源码。
> 不 fork 会话、不开新窗口，就在当前对话里原地回退。
>
> English version: [README.en.md](README.en.md)

## 它解决什么问题

用 AI 干活时，一个回合经常同时留下两类痕迹：对话里的消息，和工作区里的文件。想「回到那一步重来」时，
两者都得回到当时的样子才对 —— 只退对话会留下一地改了半截的文件，只退文件则对话还停在错误的上下文里。

`dsh-any-rollback` 把这两件事一起做：点消息上的 ↶，对话回到那条消息之前，文件也回到那一刻的状态。

| 场景 | 没有本插件 | 使用本插件 |
| --- | --- | --- |
| 生成视频的脚本跑了 3 版，想回到第 1 版 | 得手动清理 `out/` 里一堆 mp4 | 回退即还原，旧版本移入隔离区 |
| 让 AI 重构，改错了想撤回 | 对话回退后文件仍是坏的 | 对话和文件一起回到改前 |
| 多轮试错，想从某一步重来 | 开新会话，丢失上下文 | 原地回退，同窗口继续 |

## 核心功能

### 1. 按消息回退对话

每条用户消息旁有 ↶ 按钮。点它，这条消息之后的内容从对话视图上撤下（会话日志仍只追加、不删除，可追溯），
输入框自动填回被撤回的那句话，改一改就能重新提问。**输入框里原有的内容会被替换**（并弹一句提示），
这样连续回退到不同消息时，输入框里始终是当前这条被撤回的话。

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

### 4. 快照存储与配额（v0.19.1-any.19 起）

> **背景：** 早期版本把每份内容按 `<会话ID>/artifacts/blobs/<sha256>` 各存一份，
> 同一份 64 MiB 的视频在 3 个会话里就存 3 份。实测一个 `~/.dsh/rewind-snapshots/`
> 长到 **42 GB**：103,784 个 blob 里只有 27,370 份唯一内容，**26.36 GiB 是纯跨会话重复**。
> 而且自动清理默认关闭、按「闲置 30 天」判定，几天内产生的大量快照根本清不掉。

现在内容一律进**全局内容寻址仓** `<root>/_blobs/<hash前2位>/<hash>`：所有会话共享同一份
字节，相同内容全机只存一次；旧版每会话 blob 仍可读，通过 `compact` 逐步收编。清理策略
默认开启，且增加了**总配额**（默认 8 GB）：

| 命令 | 作用 |
| --- | --- |
| `/snapshot-auto-cleanup` | 查看状态（开关 / 闲置天数 / 总配额 / 压缩开关 / 已用空间） |
| `/snapshot-auto-cleanup on\|off` | 启用 / 停用自动清理 |
| `/snapshot-auto-cleanup max-age <天数>` | 设置闲置天数上限 |
| `/snapshot-auto-cleanup max-total <GB>` | 设置全局总配额（`0` = 不限，默认 8） |
| `/snapshot-auto-cleanup compact [--apply]` | 预演 / 执行：旧 blob 收编进全局仓 + 全局可达性 GC + 按配额淘汰最旧会话 |
| `/snapshot-auto-cleanup run [--apply]` | 清理 + 压缩：预演，或执行 |
| `/snapshot-auto-cleanup run --current [--apply]` | 只清理当前会话的备份 |

配额淘汰是**整组会话**为单位、按最旧优先；含隔离区 / `rescue/` / `.pending/` 的会话
不会被淘汰（那些是用户尚未取回的原始字节）。删除前一律先预演。

**存量数据一次性止血**（默认只读预演、加 `--apply --yes` 才执行，绝不碰隔离区）：

```powershell
node scripts/snapshot-doctor.mjs                     # 体检，报告可释放空间
node scripts/snapshot-doctor.mjs --json             # 机器可读
node scripts/snapshot-doctor.mjs --apply --dedup --gc --yes   # 跨会话硬链接去重 + 回收孤儿 blob
```

`--dedup` 用硬链接合并重复副本（先逐份校验 sha256），`--gc` 删除不被任何清单引用的
孤儿 blob，两者都会写审计日志 `dedup-log.jsonl`，可在同目录人工核对。

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
| `artifactExclude` | `node_modules,dist,build,out,coverage,__pycache__,venv,.venv,target` | 追踪时跳过的目录 |
| `artifactKeepManifests` | `20` | 每个会话保留的清单份数 |
| `autoCleanupEnabled` | `true` | 自动清理开关（默认开启，防止再次无声涨到 40 GB） |
| `autoCleanupMaxAgeDays` | `30` | 备份闲置多少天后可清理 |
| `autoCleanupMaxTotalGb` | `8` | 全局总配额（GiB），`0` = 不限；超出时按最旧会话整组淘汰 |
| `autoCleanupCompact` | `true` | 自动清理时是否顺带压缩（跨会话去重 + 全局 GC） |

## 数据放在哪里

```
~/.dsh/rewind-snapshots/
  _blobs/<前2位>/<sha256>   # 全局内容仓：所有会话共享，相同字节全机一份
  <会话ID>/
    <消息序号>/            # 每条消息对应的文件备份
    artifacts/
      manifests/           # 每个回合边界一份工作区清单
      quarantine/          # 回退时移出的文件（唯一副本，清理绝不触碰）
      quarantine/index.json # 每个文件的原路径
      blobs/               # 旧版每会话副本，compact 后逐步清空
```

备份目录与工作区分离（不是工作区的子目录）。删掉这个目录只会丢失回退能力，不会影响项目文件本身。

## 安装

### 从 Release 安装（推荐）

在 profile 的 `package.json` 中加依赖：

```json
"dependencies": {
  "dsh-any-rollback": "https://github.com/xinstart-1/dsh-any-rollback/releases/download/v0.19.1-any.9/dsh-any-rollback-0.19.1-any.9.tgz"
}
```

安装并重启 DSH：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

还要确认 `dsh-any-rollback` 已加入该 profile 的 `dsh.profile.bundles` 数组 —— **这个数组才是真正加载插件的开关**。

### 从源码目录安装

```json
"dsh-any-rollback": "file:C:/path/to/dsh-any-rollback/dist/dsh-any-rollback-0.19.1-any.9.tgz"
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
| `lib/index.js` | `b4aeb28dbde457d74e620c0e69ec6d3049a3aa5e7ffb02d54b15ec3c2fd3359e` |
| `lib/artifact-track.js` | `bfa582690acfeb2aa90d0fc9fe04c9d37dda764d156f71695e5ce83791fbcb80` |
| `lib/client.js` | `c312cd5c2d570dbfd456ccf1976993c1f40571b776c3e8363e0d44a42d1e6584` |

> tarball 自身的摘要会随包内 README 变化（自引用），因此不写死在文档里；
> 以 `dist/` 下实际文件为准（`Get-FileHash` / `sha256sum`），或直接对照 Release 附件页。

装完**重启 DSH** 才会生效（插件宿主侧每个进程只加载一次）。重启后跑一个回合，
确认 `~\.dsh\rewind-snapshots\<会话ID>\artifacts\manifests\` 下出现清单文件，且消息旁出现 ↶ 按钮。

## 卸载

从 profile 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-any-rollback`，重新安装依赖即可。
备份数据不会自动删除；要彻底清理，手动删除 `~/.dsh/rewind-snapshots/`。

## 设计取舍

- **只写回真正备份过的内容。** 宁可少还原，也不用推断去覆盖文件。
- **不删除任何文件。** 回退时要移出的文件一律进隔离区。
- **会话日志只追加。** 回退只改变对话视图，历史记录永远完整可查。
- **备份目录独立于工作区。** 不会污染项目，也不会被项目里的清理脚本误删。

## 已修复的问题

以下四处在早期版本中确实存在，本版已修复，并各有回归测试守着（`tests/artifact-track.regression.mjs`）。

### 1. 超上限且内容改过的文件会被移出工作区 → 已修复

单文件超过上限（`maxFileBytes` / `artifactMaxFileBytes`）时内容不被缓存。早期版本遇到「目标时刻已存在、
但内容没备份且后来改过」的文件，会按「新建产物」处理并移入隔离区，看起来像文件被删了。

现在改为**跳过并保持原样**，回退结果里会写明「N 个文件保持原样（目标时刻没有内容备份）」。
目标时刻**确实没有**该文件时，仍然会移入隔离区 —— 这是正确行为，未改变。

### 2. 1.5 秒内的同尺寸改写可能漏记 → 已修复

早期用「大小 + mtime，mtime 带 1500 ms 容差」判断变化。若文件在边界之后**大小不变、且在容差窗口内被改写**，
会沿用旧摘要，回退还原成更早的版本。

现在改为 **mtime 精确比对**：只有 mtime 完全相同才复用旧摘要，否则重新计算内容哈希。

### 3. 内容缓存从不回收 → 已修复

早期只裁剪清单，`artifacts/blobs/` 里的内容副本永不删除，会话越长占用越大。

现在每次裁剪清单后执行一次**可达性回收**：清掉不再被任何存活清单引用的 blob，
以及写入中断留下的 `.tmp-*` 临时文件。

### 4. 点目录不参与追踪 → 已修复

早期扫描跳过所有 `.` 开头的目录，产物落在 `.output/`、`.cache/` 里就不会被追踪。

现在默认**追踪点目录**，只固定跳过 VCS 与工具状态目录（`.git`、`.hg`、`.svn`、`.dsh`、`.dsh-file-attachment`）。
依赖与构建目录（`node_modules`、`dist`、`build`、`out` 等）仍按默认排除；
需要的话可以用 `artifactExclude` 自行增删。

## 仍然适用的边界

- 回退依赖已有备份。插件启用前的历史、以及关闭备份期间产生的改动没有记录，无法还原。
- 会话被压缩（compact）之后，早于压缩点的消息不再出现在回退列表中。
- 超过大小上限的文件不缓存内容，因此跨上限的那段改动无法还原（现在会明确提示，不再动文件）。

## 仓库结构

```
dist/     可安装的 tarball（Release 附件）
lib/      宿主侧与客户端侧入口
locale/   界面文案
scripts/  verify.mjs（完整性校验）、refresh.ps1（重新同步已装副本）
```

## 许可

MIT。见 [LICENSE](LICENSE)。
