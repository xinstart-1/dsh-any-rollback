# 重新生成与版本切换（regen）设计记录

> v0.19.1-any.4 加入。本文记录可行性调研、机制选择与已知边界。

## 能力总览

| 能力 | 入口 | 机制 |
| --- | --- | --- |
| 重新生成 | `/regen <序号\|@seq>` | 回退目标轮 → 产物预快照 → 追加遮蔽标记 → `agent.followup` 重发原提示 |
| 版本历史 | `/regen list` | 从会话日志推导（`op: "regenerate"` 的 user/message 标记） |
| 版本切换 | `/regen v<N>` | 追加新的替换标记（`regenSwitchTo`），产物联动对齐 |

## 关键机制

### 发送：宿主侧 `agent.followup`

重新生成卡在"如何让模型重跑"。调研结论（2026-11-02）：

- 客户端 composer 门面只有 `setDraft` / `focus`，**没有提交接口**；
- 正确通路是宿主侧的 `agents.get(sessionId)` → `agent.followup(message)`（MIT 许可的
  `yamingmou/dsh-retrace` v0.4.135 以同一 API 实现了 edit-and-resend / regenerate，
  该项目历经 0.4.x 一百余个版本验证了此 API 的稳定性）；
- `dsh-houhuiyao`、`dsh-session-kit` 走的是**模拟键盘事件**路线，依赖宿主内部实现，未采纳。

### 语义：追加修正，不是分叉

会话日志 append-only。重新生成 = 追加一条替换标记（shadowed interval 指向目标轮）：

- 旧回答与旧产物**都不删除**：对话在日志里可恢复显示，产物在隔离区可取回；
- 模型上下文被重建为干净状态：被遮蔽的旧回答不再进入可见面，目标消息之前的历史完整保留；
- 因此"切版本"切的是**模型可见面**，同一时刻只有一个版本在上下文里。

### 版本数据模型

`regenVersionsOf(events, targetSeq)`：按 `data.op === 'regenerate'` 且
`sourceEventSeqs` 含目标 user/message seq 过滤标记，一页 = 一个标记，最新页为活跃版本。
零新增存储：版本数、marker seq、遮蔽区间全部可从日志推导。

### 产物联动（本插件独有）

切版本只切对话不切文件是所有竞品的共性缺口。本插件在 regenerate/switch 前调用
`artifactTracker.recordSnapshotForRegenerate()`（负 key 清单，与正常边界共用存储与回收），
切换后执行 `restore()` 对齐产物：新版本文件进隔离区、旧版本还原。每个版本的产物可追溯。

## 已知边界

1. **助手行翻页 UI 未做**：宿主渲染器只给 `user`/`steering`/`turn-process`/`turn-trigger`
   盖 `data-chat-flow-kind` 章，助手消息行**没有独立锚点**（2026-11-02 对 0.2.1-rc.5 产物反编译确认），
   无法安全定位 `< 2/2 >` 控件。与上游 audit.md U2（消息级动作槽缺失）同源。
   宿主开放锚点后可升级为按钮形态。
   **更新（any.5 起）**：宿主随后开放了助手行动作槽，`lib/client.js` 已在每条助手回复上
   注册 ↻ 按钮；翻页控件仍缺「当前第几版 / 共几版」的锚点，故仍未做。
2. `/regen` 重发的是**原提示词文本**：图片附件不随重发（后续可接 `createDrafts` 补齐）。
3. 重新生成会真实触发一轮 AI 执行（消耗模型调用、可能改动工作区），这是功能语义，使用前有提示。
4. 负 key 预快照清单参与共享回收，被裁剪后同样不可再作为回退点（与正常清单一致）。

## 实现状态核对（v0.19.1-any.10）

对着真实宿主数据（`app.asar` 里的类型声明与实现、`~/.dsh/sessions/…/session.v4.jsonl.zstd` 里的真实事件）
逐条核对，结论如下。

**已按实测修正**

- 命令入参字段是 `invocation.rawInput`；宿主 `CommandInvocation` 是
  `{commandId, agent, rawInput, attachments, signal}`，**没有 `input`**。早先读 `invocation.input`
  时恒为空串 → `help`/`list`/`v<N>` 三个分支永远进不去，点旧回复的 ↻ 还会退化成「重生成最新一轮」。
- 标记事件的 `sourceEventSeqs` 是**事件顶层字段**（`append` 的第三个参数原样落盘），不在
  `event.data` 里；宿主还会把连续区间压成嵌套数组（实测 `"sourceEventSeqs":[[585,587],589]`）。
  统一走 `citedSeqsOf()` 展平取最小 seq。
- **`data.op` 永远不会落盘**：宿主只持久化 `data` 的 content/source/role/id（真实日志核对：
  1027 + 6354 行里 0 条事件带 `data.op`）。因此版本模型改用**命令事件**判定：`command/run`
  记 `name`、`command/done` 记 `sourceEventSeq`，配对即可知道哪些遮蔽标记是 `/regen` 写的。
  真实日志验证：regen 标记 #42 判为 regen，`/rewind` 标记 #597 不误判。
- 客户端 `rewindCutsOf()` 原先只认引擎命令（`rewind-plugin`/`rewind`），`/regen` 造成的遮蔽
  在界面上算不出区间 —— 这就是「重新生成后上面的记录还在」的直接原因。现在两种命令都认。
- 助手回复行在宿主里是 `assistant-step`，其 `data` 是
  `{status,turn,step,blocks,time,usage?,finalNode?}`，**没有 `data.seq`/`data.messageId`**；
  messageId 与 seq 都在 `data.finalNode` 上。早先按 `kind==='assistant'` + `data.messageId`
  找，真实会话里永远匹配不到 → 按钮解析不出目标 seq。
- `executeRegenerate` 中断在飞的回复后要 `dropPendingSteering()`，否则被中断那轮残留的
  steering 会被随后的 `followup` 认领（与 `/rewind` 对齐）。

**版本切换：纯客户端实现（v0.19.1-any.11）**

- 宿主的 surface 折叠（`SurfaceOp = 'append' | replace{startSeq,endSeq}`，应用时
  `nodes.splice(startIdx, endIdx-startIdx+1, plan.seq)`）**只影响模型上下文**：
  被遮蔽的旧事件从 surface 数组里被删除，但**浏览器端 Chat 节点仓库仍然保留这些行**
  （本插件的 `installChatViewVisibility` 补丁存在的理由）。
- ⇒ 「切回旧版本、重新显示旧回答」**不需要动宿主，也不需要重跑模型**：把
  「整段隐藏 `[target, marker]`」改成「按选中版本隐藏其它版本区间」即可。
  `RewindVisibilityBuilder.selectedVersion` + `annotateVersionCuts()` 实现这一点，
  `‹ N/M ›` 点击后立刻重建视图（纯前端、瞬时）。
- 模型上下文仍是最新版——这是有意的：否则模型会看到旧答案。
- `/regen v<N>` 保留为「从第 N 版回退点重新执行」的命令形态；`v<total>`（原始轮）
  如实报不可恢复（那条路径确实要改 surface）。
- 版本数据来自 `versions` RPC：`{index, markerSeq, targetSeq, startSeq, endSeq}`，
  全部从会话日志推导（`command/run` + `command/done` 配对判定 regen 标记），
  不依赖任何不落盘的字段。

**仍待真机验证**

- `versions` RPC 与 `‹ N/M ›` 控件需要在重启后点一次 ↻ 才能看到（宿主每个进程只加载一次插件）。

## 许可说明

`agent.followup` 的用法参考了 `yamingmou/dsh-retrace`（MIT, © 2025 dsh-retrace contributors），
依照 MIT 在本仓库 LICENSE 的附录段致谢。
