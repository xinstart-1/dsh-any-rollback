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

## 实现状态核对（v0.19.1-any.9）

对着真实宿主数据（`app.asar` 里的类型声明、`~/.dsh/sessions/…/session.v4.jsonl.zstd` 里的真实事件）
核对了一遍，结论如下。

**已按实测修正**

- 命令入参字段是 `invocation.rawInput`；宿主 `CommandInvocation` 是
  `{commandId, agent, rawInput, attachments, signal}`，**没有 `input`**。早先读 `invocation.input`
  时恒为空串 → `help`/`list`/`v<N>` 三个分支永远进不去，点旧回复的 ↻ 还会退化成「重生成最新一轮」。
- 标记事件的 `sourceEventSeqs` 是**事件顶层字段**（`append` 的第三个参数原样落盘），不在
  `event.data` 里；宿主还会把连续区间压成嵌套数组（实测 `"sourceEventSeqs":[[585,587],589]`）。
  统一走 `citedSeqsOf()` 展平取最小 seq。
- `executeRegenerate` 与 `executeRegenSwitch` 中断在飞的回复后都要 `dropPendingSteering()`，
  否则被中断那轮残留的 steering 会被随后的 `followup` 认领（与 `/rewind` 对齐）。

**尚未在真机验证（需要一次真实点击 + 翻会话日志）**

- 版本历史/版本切换依赖自定义字段 `event.data.op === "regenerate"`。宿主是否把消息对象上的
  `data` 原样落盘尚未确认；若不落盘，`/regen list` 会一直显示「没有记录」、`/regen v<N>`
  会答「暂不支持切回原始轮」。确认方法：点一次 ↻，再看日志里该标记事件是否带 `data.op`。
- `/regen v<N>` 仍以被遮蔽区间的起点（`cited[0]`）作为回退目标；该 seq 若已被自己的标记
  遮蔽，`planRewind` 会以 `not-on-surface` 拒绝。版本切换的定位方式需要按 marker 区间重做。

## 许可说明

`agent.followup` 的用法参考了 `yamingmou/dsh-retrace`（MIT, © 2025 dsh-retrace contributors），
依照 MIT 在本仓库 LICENSE 的附录段致谢。
