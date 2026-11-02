// src/index.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { copyFile as copyFile2, rm as rm2, stat as stat2, unlink } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { ArtifactTracker } from "./artifact-track.js";

// src/locales.ts
var en = {
  "regen.list": "{count} regenerate entries:",
  "regen.listEmpty": "No regenerate history in this session.",
  "regen.switched": "Switched to version {index} (from #{targetSeq}). {restore}",
  "regen.description": "Regenerate from an earlier message: rewinds the turn and re-sends its prompt (artifacts snapshotted first)",
  "regen.usage": "Usage:\\n  /regen <index|@seq>    rewind to the turn at that point and re-send its prompt\\n  /regen list            show the regenerate history (version pages)",
  "regen.inflight": "A regenerate/rewind is already running for this session.",
  "regen.unsupported": "The harness did not expose a followup channel for this session; regenerate is unavailable.",
  "regen.stopFailed": "Could not stop the running reply; try again once it settles.",
  "regen.cancelled": "Cancelled.",
  "regen.noPrompt": "No text found on the user message at seq {seq}; cannot regenerate.",
  "regen.failed": "Regenerate failed: {error}",
  "regen.success": "Rewound to #{targetSeq}. {restore}",
  "regen.resendNote": "\\nThe original prompt has been re-sent; the model will answer fresh and re-run its commands.",
  "artifact.prefix": "artifacts: ",
  "artifact.moved": "{count} file(s) moved to quarantine ({dir})",
  "artifact.unbacked": "{count} file(s) left as-is (no content backup for that point)",
  "artifact.failed": "{count} artifact file(s) failed",
  "plan.skip": "  not restored: {path} ({reason})",
  "skipReason.oversized": "over the {limit} backup limit, so the recorded state predates untracked edits",
  "error.invalidTarget": 'Cannot parse target "{raw}" (expected <index> or @<seq>)',
  "sep.list": ", ",
  "sep.clause": "; ",
  "failures.suffix": "; {count} file(s) failed to restore: {list}",
  "failures.item": "{path} ({message})",
  "inflight": "A rewind is already running for this session; please wait.",
  "stopFailed": "Could not stop the running agent; rewind cancelled. Please try again.",
  "cancelled": "Rewind cancelled.",
  "failed": "Rewind failed: {error}. The session is unchanged.",
  "restore.count": "restored {count} file(s)",
  "delete.count": "deleted {count} file(s)",
  "skip.count": "skipped {count} path(s)",
  "noRestorable": "; no restorable write-class changes after the target",
  "backupOff": "snapshot backups are off, so the restore may be incomplete",
  "storeUnsupported": "file restore unavailable: these snapshots use a newer store format (v{version}) than this plugin understands; nothing was changed. Update the plugin or clear this session's snapshots.",
  "success": "Withdrawn seq {targetSeq} and everything after it (conversation returned to earlier){restore}.",
  "noUserMessages": "This session has no rewindable user messages yet.",
  "command.description": "Rewind the conversation and/or files to a previous point",
  "command.undoDescription": "Alias of /rewind",
  "engine.description": "dsh-rewind internal command",
  "engine.rejected": "Internal command: use /rewind or /undo.",
  "engine.inputHint": "@<seq> chat|both",
  "cleanup.description": "Manage automatic cleanup of session snapshot backups",
  "cleanup.inputHint": "on | off | max-age <days> | run [--apply] [--current]",
  "cleanup.status": "Auto-cleanup: {state}. Max age: {days} day(s).",
  "cleanup.enabled": "enabled",
  "cleanup.disabled": "disabled",
  "cleanup.onOk": "Auto-cleanup enabled.",
  "cleanup.offOk": "Auto-cleanup disabled \u2014 all snapshots kept.",
  "cleanup.maxAgeOk": "Auto-cleanup max age set to {days} day(s).",
  "cleanup.cfgInvalid": 'Snapshot cleanup config invalid: {detail}. Nothing was executed; use "on|off|max-age" to reset the config.',
  "cleanup.saveFailed": "Could not save cleanup config: {detail}.",
  "cleanup.runDry": "Dry-run: would remove {deleted} session snapshot backup(s), freeing {freed} bytes. Re-run with --apply to delete.",
  "cleanup.runApply": "Removed {deleted} session snapshot backup(s), freeing {freed} bytes; {kept} kept, {remaining} bytes remain.",
  "cleanup.runFailed": "Cleanup failed: {detail}.",
  "cleanup.skipped": "({skipped} active session(s) skipped.)",
  "cleanup.clearDry": "Dry-run: would clear {entries} snapshot(s) of the current session, freeing {bytes} bytes. Re-run with --apply to delete.",
  "cleanup.clearApply": "Cleared {entries} snapshot(s) of the current session, freeing {bytes} bytes. This session now records snapshots fresh from its current state.",
  "cleanup.clearActive": "Could not clear session {sessionId}: the session is still running and could not be stopped. Try again once it is idle.",
  "cleanup.clearCancelled": "Clear cancelled.",
  "cleanup.clearFailed": "Could not clear session {sessionId}: {detail}.",
  "cleanup.usage": "Usage:\n  /snapshot-auto-cleanup                 show status\n  /snapshot-auto-cleanup on|off          enable/disable auto-cleanup\n  /snapshot-auto-cleanup max-age <days>  set the idle cutoff\n  /snapshot-auto-cleanup run [--apply]   dry-run, or execute with --apply\n  /snapshot-auto-cleanup run --current [--apply]   dry-run/clear this session's snapshots"
};
var zh = {
  "regen.list": "共 {count} 条重新生成记录：",
  "regen.listEmpty": "本会话还没有重新生成记录。",
  "regen.switched": "已切换到版本 {index}（回退点 #{targetSeq}）。{restore}",
  "regen.description": "从更早的消息重新生成：回退该轮并重发原提示（产物先快照）",
  "regen.usage": "用法：\\n  /regen <序号|@seq>    回退到该位置并重发其提示词\\n  /regen list           查看重新生成历史（版本页）",
  "regen.inflight": "本会话已有一次回退/重新生成在执行。",
  "regen.unsupported": "宿主未提供本会话的 followup 通道，重新生成不可用。",
  "regen.stopFailed": "无法停止正在生成的回复；等它结束后再试。",
  "regen.cancelled": "已取消。",
  "regen.noPrompt": "序号 {seq} 的用户消息没有文本，无法重新生成。",
  "regen.failed": "重新生成失败：{error}",
  "regen.success": "已回退到 #{targetSeq}。{restore}",
  "regen.resendNote": "\\n原提示词已重新发送，模型将重新回答并重跑命令。",
  "artifact.prefix": "产物：",
  "artifact.moved": "{count} 个文件移入隔离区（{dir}）",
  "artifact.unbacked": "{count} 个文件保持原样（目标时刻没有内容备份）",
  "artifact.failed": "{count} 个产物文件处理失败",
  "plan.skip": "  \u672A\u8FD8\u539F\uFF1A{path}\uFF08{reason}\uFF09",
  "skipReason.oversized": "\u5DF2\u8D85\u8FC7 {limit} \u7684\u5907\u4EFD\u4E0A\u9650\uFF0C\u8BB0\u5F55\u7684\u72B6\u6001\u65E9\u4E8E\u672A\u88AB\u8DDF\u8E2A\u7684\u4FEE\u6539",
  "error.invalidTarget": '\u65E0\u6CD5\u89E3\u6790\u76EE\u6807 "{raw}"\uFF08\u5E94\u4E3A <\u5E8F\u53F7> \u6216 @<seq>\uFF09',
  "sep.list": "\u3001",
  "sep.clause": "\uFF1B",
  "failures.suffix": "\uFF1B{count} \u4E2A\u6587\u4EF6\u8FD8\u539F\u5931\u8D25\uFF1A{list}",
  "failures.item": "{path}\uFF08{message}\uFF09",
  "inflight": "\u8BE5\u4F1A\u8BDD\u5DF2\u6709\u4E00\u4E2A\u56DE\u9000\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u7A0D\u5019\u3002",
  "stopFailed": "\u65E0\u6CD5\u505C\u6B62\u8FD0\u884C\u4E2D\u7684 agent\uFF0C\u56DE\u9000\u5DF2\u53D6\u6D88\u3002\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002",
  "cancelled": "\u56DE\u9000\u5DF2\u53D6\u6D88\u3002",
  "failed": "\u56DE\u9000\u5931\u8D25\uFF1A{error}\u3002\u4F1A\u8BDD\u672A\u6539\u53D8\u3002",
  "restore.count": "\u8FD8\u539F {count} \u4E2A\u6587\u4EF6",
  "delete.count": "\u5220\u9664 {count} \u4E2A\u6587\u4EF6",
  "skip.count": "\u8DF3\u8FC7 {count} \u4E2A\u8DEF\u5F84",
  "noRestorable": "\uFF1B\u76EE\u6807\u4E4B\u540E\u6CA1\u6709\u53EF\u8FD8\u539F\u7684\u5199\u7C7B\u53D8\u66F4",
  "backupOff": "\u5FEB\u7167\u5907\u4EFD\u5DF2\u5173\u95ED\uFF0C\u8FD8\u539F\u53EF\u80FD\u4E0D\u5145\u5206",
  "storeUnsupported": "\u6587\u4EF6\u8FD8\u539F\u4E0D\u53EF\u7528\uFF1A\u8FD9\u4E9B\u5FEB\u7167\u4F7F\u7528\u4E86\u6BD4\u672C\u63D2\u4EF6\u66F4\u65B0\u7684\u5B58\u50A8\u683C\u5F0F\uFF08v{version}\uFF09\uFF1B\u5DE5\u4F5C\u533A\u672A\u505A\u4EFB\u4F55\u6539\u52A8\u3002\u8BF7\u66F4\u65B0\u63D2\u4EF6\uFF0C\u6216\u6E05\u9664\u8BE5\u4F1A\u8BDD\u7684\u5FEB\u7167\u3002",
  "success": "\u5DF2\u64A4\u56DE seq {targetSeq} \u53CA\u4E4B\u540E\u5185\u5BB9\uFF08\u5BF9\u8BDD\u5DF2\u56DE\u5230\u6B64\u524D\uFF09{restore}\u3002",
  "noUserMessages": "\u5F53\u524D\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u53EF\u56DE\u9000\u7684\u7528\u6237\u6D88\u606F\u3002",
  "command.description": "\u628A\u5BF9\u8BDD\u548C/\u6216\u6587\u4EF6\u56DE\u9000\u5230\u4E4B\u524D\u7684\u67D0\u6761\u6D88\u606F",
  "command.undoDescription": "/rewind \u7684\u522B\u540D",
  "engine.description": "dsh-rewind \u5185\u90E8\u547D\u4EE4",
  "engine.rejected": "\u5185\u90E8\u547D\u4EE4\uFF1A\u8BF7\u4F7F\u7528 /rewind \u6216 /undo\u3002",
  "engine.inputHint": "@<seq> chat|both",
  "cleanup.description": "\u7BA1\u7406\u4F1A\u8BDD\u5FEB\u7167\u5907\u4EFD\u7684\u81EA\u52A8\u6E05\u7406",
  "cleanup.inputHint": "on | off | max-age <\u5929\u6570> | run [--apply] [--current]",
  "cleanup.status": "\u81EA\u52A8\u6E05\u7406\uFF1A{state}\u3002\u6700\u5927\u4FDD\u7559\u5929\u6570\uFF1A{days} \u5929\u3002",
  "cleanup.enabled": "\u5DF2\u5F00\u542F",
  "cleanup.disabled": "\u5DF2\u5173\u95ED",
  "cleanup.onOk": "\u5DF2\u5F00\u542F\u81EA\u52A8\u6E05\u7406\u3002",
  "cleanup.offOk": "\u5DF2\u5173\u95ED\u81EA\u52A8\u6E05\u7406\u2014\u2014\u4FDD\u7559\u5168\u90E8\u5FEB\u7167\u3002",
  "cleanup.maxAgeOk": "\u5DF2\u5C06\u81EA\u52A8\u6E05\u7406\u7684\u6700\u5927\u4FDD\u7559\u5929\u6570\u8BBE\u4E3A {days} \u5929\u3002",
  "cleanup.cfgInvalid": "\u5FEB\u7167\u6E05\u7406\u914D\u7F6E\u65E0\u6548\uFF1A{detail}\u3002\u672A\u6267\u884C\u4EFB\u4F55\u64CD\u4F5C\uFF1B\u8BF7\u7528\u300Con|off|max-age\u300D\u91CD\u8BBE\u914D\u7F6E\u4EE5\u4FEE\u590D\u3002",
  "cleanup.saveFailed": "\u65E0\u6CD5\u4FDD\u5B58\u6E05\u7406\u914D\u7F6E\uFF1A{detail}\u3002",
  "cleanup.runDry": "\u9884\u6F14\uFF1A\u5C06\u5220\u9664 {deleted} \u4E2A\u4F1A\u8BDD\u7684\u5FEB\u7167\u5907\u4EFD\uFF0C\u91CA\u653E {freed} \u5B57\u8282\u3002\u52A0 --apply \u6B63\u5F0F\u5220\u9664\u3002",
  "cleanup.runApply": "\u5DF2\u5220\u9664 {deleted} \u4E2A\u4F1A\u8BDD\u7684\u5FEB\u7167\u5907\u4EFD\uFF0C\u91CA\u653E {freed} \u5B57\u8282\uFF1B\u4FDD\u7559 {kept} \u4E2A\uFF0C\u5269\u4F59 {remaining} \u5B57\u8282\u3002",
  "cleanup.runFailed": "\u6E05\u7406\u5931\u8D25\uFF1A{detail}\u3002",
  "cleanup.skipped": "\uFF08\u8DF3\u8FC7\u4E86 {skipped} \u4E2A\u6D3B\u52A8\u4F1A\u8BDD\u3002\uFF09",
  "cleanup.clearDry": "\u9884\u6F14\uFF1A\u5C06\u6E05\u9664\u5F53\u524D\u4F1A\u8BDD\u7684 {entries} \u4E2A\u5FEB\u7167\uFF0C\u91CA\u653E {bytes} \u5B57\u8282\u3002\u52A0 --apply \u6B63\u5F0F\u5220\u9664\u3002",
  "cleanup.clearApply": "\u5DF2\u6E05\u9664\u5F53\u524D\u4F1A\u8BDD\u7684 {entries} \u4E2A\u5FEB\u7167\uFF0C\u91CA\u653E {bytes} \u5B57\u8282\u3002\u8BE5\u4F1A\u8BDD\u5DF2\u91CD\u7F6E\u4E3A\u4ECE\u5F53\u524D\u72B6\u6001\u91CD\u65B0\u8BB0\u5F55\u5FEB\u7167\u3002",
  "cleanup.clearActive": "\u65E0\u6CD5\u6E05\u9664\u4F1A\u8BDD {sessionId}\uFF1A\u4F1A\u8BDD\u4ECD\u5728\u8FD0\u884C\u4E14\u672A\u80FD\u505C\u6B62\uFF0C\u8BF7\u5F85\u5176\u7A7A\u95F2\u540E\u91CD\u8BD5\u3002",
  "cleanup.clearCancelled": "\u6E05\u7A7A\u5DF2\u53D6\u6D88\u3002",
  "cleanup.clearFailed": "\u65E0\u6CD5\u6E05\u9664\u4F1A\u8BDD {sessionId}\uFF1A{detail}\u3002",
  "cleanup.usage": "\u7528\u6CD5\uFF1A\n  /snapshot-auto-cleanup                 \u67E5\u770B\u72B6\u6001\n  /snapshot-auto-cleanup on|off          \u5F00\u542F/\u5173\u95ED\u81EA\u52A8\u6E05\u7406\n  /snapshot-auto-cleanup max-age <\u5929\u6570>  \u8BBE\u7F6E\u5931\u6D3B\u9608\u503C\uFF08\u5929\uFF09\n  /snapshot-auto-cleanup run [--apply]   \u9884\u6F14\uFF0C\u6216\u52A0 --apply \u6267\u884C\n  /snapshot-auto-cleanup run --current [--apply]  \u9884\u6F14/\u6E05\u9664\u672C\u4F1A\u8BDD\u5FEB\u7167"
};
var ja = {
  "regen.list": "{count} 件の再生成履歴：",
  "regen.listEmpty": "このセッションには再生成履歴がありません。",
  "regen.switched": "バージョン {index} に切り替えました（#{targetSeq} から）。{restore}",
  "regen.description": "以前のメッセージから再生成：このターンを巻き戻し、元のプロンプトを再送します（アーティファクトは事前スナップショット）",
  "regen.usage": "使い方：\\n  /regen <番号|@seq>    その位置まで巻き戻し、プロンプトを再送\\n  /regen list           再生成履歴（バージョンページ）を表示",
  "regen.inflight": "このセッションでは既にロールバック/再生成が実行中です。",
  "regen.unsupported": "ホストがこのセッションの followup チャネルを提供していないため、再生成は利用できません。",
  "regen.stopFailed": "実行中の応答を停止できませんでした。落ち着いてから再試行してください。",
  "regen.cancelled": "キャンセルしました。",
  "regen.noPrompt": "seq {seq} のユーザーメッセージにテキストがなく、再生成できません。",
  "regen.failed": "再生成に失敗しました：{error}",
  "regen.success": "#{targetSeq} まで巻き戻しました。{restore}",
  "regen.resendNote": "\\n元のプロンプトを再送しました。モデルが新しい回答を生成し、コマンドを再実行します。",
  "artifact.prefix": "生成物：",
  "artifact.moved": "{count} 件を隔離ディレクトリへ移動（{dir}）",
  "artifact.unbacked": "{count} 件はそのまま残しました（その時点の内容バックアップなし）",
  "artifact.failed": "{count} 件の生成物処理に失敗",
  "plan.skip": "  \u5FA9\u5143\u5BFE\u8C61\u5916\uFF1A{path}\uFF08{reason}\uFF09",
  "skipReason.oversized": "{limit} \u306E\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u4E0A\u9650\u3092\u8D85\u3048\u3066\u3044\u308B\u305F\u3081\u3001\u8A18\u9332\u3055\u308C\u305F\u72B6\u614B\u306F\u672A\u8FFD\u8DE1\u306E\u7DE8\u96C6\u3088\u308A\u524D\u306E\u3082\u306E\u3067\u3059",
  "error.invalidTarget": '\u5BFE\u8C61 "{raw}" \u3092\u89E3\u6790\u3067\u304D\u307E\u305B\u3093\uFF08<index> \u307E\u305F\u306F @<seq> \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\uFF09',
  "sep.list": "\u3001",
  "sep.clause": "\uFF1B",
  "failures.suffix": "\uFF1B{count} \u4EF6\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u5FA9\u5143\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF1A{list}",
  "failures.item": "{path}\uFF08{message}\uFF09",
  "inflight": "\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u3067\u306F\u65E2\u306B\u5DFB\u304D\u623B\u3057\u304C\u5B9F\u884C\u4E2D\u3067\u3059\u3002\u304A\u5F85\u3061\u304F\u3060\u3055\u3044\u3002",
  "stopFailed": "\u5B9F\u884C\u4E2D\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3092\u505C\u6B62\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u5DFB\u304D\u623B\u3057\u3092\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3057\u305F\u3002\u3082\u3046\u4E00\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044\u3002",
  "cancelled": "\u5DFB\u304D\u623B\u3057\u3092\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3057\u305F\u3002",
  "failed": "\u5DFB\u304D\u623B\u3057\u306B\u5931\u6557\u3057\u307E\u3057\u305F\uFF1A{error}\u3002\u30BB\u30C3\u30B7\u30E7\u30F3\u306F\u5909\u66F4\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002",
  "restore.count": "{count} \u4EF6\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u5FA9\u5143\u3057\u307E\u3057\u305F",
  "delete.count": "{count} \u4EF6\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u524A\u9664\u3057\u307E\u3057\u305F",
  "skip.count": "{count} \u4EF6\u306E\u30D1\u30B9\u3092\u30B9\u30AD\u30C3\u30D7\u3057\u307E\u3057\u305F",
  "noRestorable": "\uFF1B\u5BFE\u8C61\u3088\u308A\u5F8C\u306B\u5FA9\u5143\u3067\u304D\u308B\u66F8\u8FBC\u307F\u7CFB\u306E\u5909\u66F4\u306F\u3042\u308A\u307E\u305B\u3093",
  "backupOff": "\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u306E\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u304C\u7121\u52B9\u306A\u305F\u3081\u3001\u5FA9\u5143\u304C\u4E0D\u5B8C\u5168\u306B\u306A\u308B\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059",
  "storeUnsupported": "\u30D5\u30A1\u30A4\u30EB\u3092\u5FA9\u5143\u3067\u304D\u307E\u305B\u3093\uFF1A\u3053\u308C\u3089\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u306F\u3001\u3053\u306E\u30D7\u30E9\u30B0\u30A4\u30F3\u304C\u7406\u89E3\u3067\u304D\u308B\u5F62\u5F0F\u3088\u308A\u65B0\u3057\u3044\u4FDD\u5B58\u5F62\u5F0F\uFF08v{version}\uFF09\u3092\u4F7F\u3063\u3066\u3044\u307E\u3059\u3002\u4F55\u3082\u5909\u66F4\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002\u30D7\u30E9\u30B0\u30A4\u30F3\u3092\u66F4\u65B0\u3059\u308B\u304B\u3001\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u3092\u6D88\u53BB\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "success": "seq {targetSeq} \u3068\u305D\u308C\u4EE5\u964D\u3092\u64A4\u56DE\u3057\u307E\u3057\u305F\uFF08\u4F1A\u8A71\u306F\u4EE5\u524D\u306E\u72B6\u614B\u306B\u623B\u308A\u307E\u3057\u305F\uFF09{restore}\u3002",
  "noUserMessages": "\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306B\u306F\u307E\u3060\u5DFB\u304D\u623B\u3057\u3067\u304D\u308B\u30E6\u30FC\u30B6\u30FC\u30E1\u30C3\u30BB\u30FC\u30B8\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "command.description": "\u4F1A\u8A71\u3084\u30D5\u30A1\u30A4\u30EB\u3092\u4EE5\u524D\u306E\u6642\u70B9\u307E\u3067\u5DFB\u304D\u623B\u3057\u307E\u3059",
  "command.undoDescription": "/rewind \u306E\u30A8\u30A4\u30EA\u30A2\u30B9",
  "engine.description": "dsh-rewind \u306E\u5185\u90E8\u30B3\u30DE\u30F3\u30C9",
  "engine.rejected": "\u5185\u90E8\u30B3\u30DE\u30F3\u30C9\u3067\u3059\u3002/rewind \u307E\u305F\u306F /undo \u3092\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
  "engine.inputHint": "@<seq> chat|both",
  "cleanup.description": "\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u306E\u81EA\u52D5\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u3092\u7BA1\u7406\u3057\u307E\u3059",
  "cleanup.inputHint": "on | off | max-age <\u65E5\u6570> | run [--apply] [--current]",
  "cleanup.status": "\u81EA\u52D5\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\uFF1A{state}\u3002\u6700\u5927\u4FDD\u6301\u671F\u9593\uFF1A{days} \u65E5\u3002",
  "cleanup.enabled": "\u6709\u52B9",
  "cleanup.disabled": "\u7121\u52B9",
  "cleanup.onOk": "\u81EA\u52D5\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u3092\u6709\u52B9\u306B\u3057\u307E\u3057\u305F\u3002",
  "cleanup.offOk": "\u81EA\u52D5\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u3092\u7121\u52B9\u306B\u3057\u307E\u3057\u305F \u2014 \u3059\u3079\u3066\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u304C\u4FDD\u6301\u3055\u308C\u307E\u3059\u3002",
  "cleanup.maxAgeOk": "\u81EA\u52D5\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u306E\u6700\u5927\u4FDD\u6301\u671F\u9593\u3092 {days} \u65E5\u306B\u8A2D\u5B9A\u3057\u307E\u3057\u305F\u3002",
  "cleanup.cfgInvalid": '\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u306E\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u8A2D\u5B9A\u304C\u7121\u52B9\u3067\u3059\uFF1A{detail}\u3002\u4F55\u3082\u5B9F\u884C\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"on|off|max-age" \u3067\u8A2D\u5B9A\u3092\u30EA\u30BB\u30C3\u30C8\u3057\u3066\u304F\u3060\u3055\u3044\u3002',
  "cleanup.saveFailed": "\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u8A2D\u5B9A\u3092\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF1A{detail}\u3002",
  "cleanup.runDry": "\u30C9\u30E9\u30A4\u30E9\u30F3\uFF1A{deleted} \u4EF6\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u3092\u524A\u9664\u3057\u3001{freed} \u30D0\u30A4\u30C8\u3092\u89E3\u653E\u3057\u307E\u3059\u3002\u5B9F\u969B\u306B\u524A\u9664\u3059\u308B\u306B\u306F --apply \u3092\u4ED8\u3051\u3066\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "cleanup.runApply": "{deleted} \u4EF6\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u3092\u524A\u9664\u3057\u3001{freed} \u30D0\u30A4\u30C8\u3092\u89E3\u653E\u3057\u307E\u3057\u305F\u3002{kept} \u4EF6\u3092\u4FDD\u6301\u3057\u3001\u6B8B\u308A\u306F {remaining} \u30D0\u30A4\u30C8\u3067\u3059\u3002",
  "cleanup.runFailed": "\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u306B\u5931\u6557\u3057\u307E\u3057\u305F\uFF1A{detail}\u3002",
  "cleanup.skipped": "\uFF08\u30A2\u30AF\u30C6\u30A3\u30D6\u306A\u30BB\u30C3\u30B7\u30E7\u30F3 {skipped} \u4EF6\u3092\u30B9\u30AD\u30C3\u30D7\u3057\u307E\u3057\u305F\u3002\uFF09",
  "cleanup.clearDry": "\u30C9\u30E9\u30A4\u30E9\u30F3\uFF1A\u73FE\u5728\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8 {entries} \u4EF6\u3092\u6D88\u53BB\u3057\u3001{bytes} \u30D0\u30A4\u30C8\u3092\u89E3\u653E\u3057\u307E\u3059\u3002\u5B9F\u969B\u306B\u524A\u9664\u3059\u308B\u306B\u306F --apply \u3092\u4ED8\u3051\u3066\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "cleanup.clearApply": "\u73FE\u5728\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8 {entries} \u4EF6\u3092\u6D88\u53BB\u3057\u3001{bytes} \u30D0\u30A4\u30C8\u3092\u89E3\u653E\u3057\u307E\u3057\u305F\u3002\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306F\u73FE\u5728\u306E\u72B6\u614B\u304B\u3089\u65B0\u3057\u304F\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u3092\u8A18\u9332\u3057\u307E\u3059\u3002",
  "cleanup.clearActive": "\u30BB\u30C3\u30B7\u30E7\u30F3 {sessionId} \u3092\u6D88\u53BB\u3067\u304D\u307E\u305B\u3093\uFF1A\u30BB\u30C3\u30B7\u30E7\u30F3\u306F\u307E\u3060\u5B9F\u884C\u4E2D\u3067\u3001\u505C\u6B62\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u30A2\u30A4\u30C9\u30EB\u72B6\u614B\u306B\u306A\u3063\u3066\u304B\u3089\u3082\u3046\u4E00\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044\u3002",
  "cleanup.clearCancelled": "\u6D88\u53BB\u3092\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3057\u305F\u3002",
  "cleanup.clearFailed": "\u30BB\u30C3\u30B7\u30E7\u30F3 {sessionId} \u3092\u6D88\u53BB\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF1A{detail}\u3002",
  "cleanup.usage": "\u4F7F\u3044\u65B9\uFF1A\n  /snapshot-auto-cleanup                 \u72B6\u614B\u3092\u8868\u793A\n  /snapshot-auto-cleanup on|off          \u81EA\u52D5\u30AF\u30EA\u30FC\u30F3\u30A2\u30C3\u30D7\u306E\u6709\u52B9/\u7121\u52B9\n  /snapshot-auto-cleanup max-age <\u65E5\u6570>  \u30A2\u30A4\u30C9\u30EB\u3057\u304D\u3044\u5024\u3092\u8A2D\u5B9A\n  /snapshot-auto-cleanup run [--apply]   \u30C9\u30E9\u30A4\u30E9\u30F3\u3001\u307E\u305F\u306F --apply \u3067\u5B9F\u884C\n  /snapshot-auto-cleanup run --current [--apply]   \u30C9\u30E9\u30A4\u30E9\u30F3\uFF0F\u73FE\u5728\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30B9\u30CA\u30C3\u30D7\u30B7\u30E7\u30C3\u30C8\u3092\u6D88\u53BB"
};
var HOST_DICTS = { en, zh, ja };
var DEFAULT_HOST_LOCALE = "en";
function isHostLocale(tag) {
  return Object.hasOwn(HOST_DICTS, tag);
}
function preferredLocale(preference) {
  if (typeof preference !== "string") return DEFAULT_HOST_LOCALE;
  const tag = preference.toLowerCase();
  if (isHostLocale(tag)) return tag;
  const primary = tag.split("-")[0];
  return primary !== void 0 && isHostLocale(primary) ? primary : DEFAULT_HOST_LOCALE;
}
function translate(lang, key, params = {}) {
  const dict = HOST_DICTS[lang] ?? en;
  let text = dict[key] ?? key;
  for (const [name2, value] of Object.entries(params)) {
    text = text.split(`{${name2}}`).join(String(value));
  }
  return text;
}

// src/marker.ts
var REWIND_MARKER_KIND = "dsh-rewind";
var REWIND_MARKER_SOURCE = Object.freeze({ kind: REWIND_MARKER_KIND });

// src/rewind.ts
var RewindError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RewindError";
  }
  code;
};
var CANDIDATE_PREVIEW_CHARS = 80;
var DEFAULT_CANDIDATE_LIMIT = 100;
function isUserMessageEvent(event) {
  return event.type === "user/message";
}
function isHumanUserMessageEvent(event) {
  return isUserMessageEvent(event) && event.data.source.kind === "user";
}
function messagePreview(message) {
  const text = message.content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "").join("").replace(/\s+/g, " ").trim();
  return text.length <= CANDIDATE_PREVIEW_CHARS ? text : `${text.slice(0, CANDIDATE_PREVIEW_CHARS - 1)}\u2026`;
}
var SEQ_TOKEN = /^@(\d+)$/;
var INDEX_TOKEN = /^(\d+)$/;
function parseRewindTarget(raw) {
  const token = raw.trim();
  const seq = SEQ_TOKEN.exec(token);
  if (seq !== null) {
    const value = Number(seq[1] ?? "");
    return Number.isSafeInteger(value) ? { kind: "seq", seq: value } : void 0;
  }
  const index = INDEX_TOKEN.exec(token);
  if (index !== null) {
    const value = Number(index[1] ?? "");
    return Number.isSafeInteger(value) && value >= 1 ? { kind: "index", index: value } : void 0;
  }
  return void 0;
}
function listRewindCandidates(events, surface, limit = DEFAULT_CANDIDATE_LIMIT) {
  const surfaceIndexes = /* @__PURE__ */ new Map();
  for (let i = 0; i < surface.length; i++) surfaceIndexes.set(surface[i], i);
  const candidates = [];
  for (let i = events.length - 1; i >= 0 && candidates.length < limit; i--) {
    const event = events[i];
    if (!isHumanUserMessageEvent(event)) continue;
    if (!surfaceIndexes.has(event.seq)) continue;
    candidates.push({
      seq: event.seq,
      time: event.time,
      preview: messagePreview(event.data),
      index: candidates.length + 1
    });
  }
  return candidates;
}
function planRewind(events, surface, target) {
  let targetSeq;
  if (target.kind === "seq") {
    targetSeq = target.seq;
  } else {
    const candidate = listRewindCandidates(events, surface, target.index)[target.index - 1];
    if (candidate === void 0) {
      throw new RewindError("invalid-index", `rewind index ${target.index} has no candidate`);
    }
    targetSeq = candidate.seq;
  }
  const targetEvent = events.find((event) => event.seq === targetSeq);
  if (targetEvent === void 0) {
    throw new RewindError("not-a-user-message", `no session event at seq ${targetSeq}`);
  }
  if (!isHumanUserMessageEvent(targetEvent)) {
    throw new RewindError(
      "not-a-user-message",
      `session event at seq ${targetSeq} is not a human user message (${targetEvent.type})`
    );
  }
  const targetIndex = surface.indexOf(targetSeq);
  if (targetIndex === -1) {
    throw new RewindError(
      "not-on-surface",
      `user message at seq ${targetSeq} is no longer in the model context (shadowed by compaction)`
    );
  }
  const shadowedSeqs = surface.slice(targetIndex);
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1]
  };
}

// src/snapshot.ts
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
var SNAPSHOT_DIR_NAME = "rewind-snapshots";
var SIDECAR_SUFFIX = ".before";
var PENDING_DIR = ".pending";
var RESCUE_DIR = "rescue";
var JOURNAL_PREFIX = "journal-";
var LEGACY_JOURNAL_PREFIX = "restore-journal-";
var PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var COMPARE_CHUNK_BYTES = 64 * 1024;
var REPLACEMENT_CHAR = "\uFFFD";
var DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
var MAX_ANCHOR_GROUPS = 100;
var CURRENT_STORE_VERSION = 2;
var UnknownStoreVersionError = class extends Error {
  constructor(version, source) {
    super(`snapshot store version ${version} is newer than this plugin understands (${source})`);
    this.version = version;
    this.source = source;
    this.name = "UnknownStoreVersionError";
  }
  version;
  source;
};
function textSourceOf(text) {
  return text.includes(REPLACEMENT_CHAR) ? { kind: "lossyText", text } : { kind: "text", bytes: Buffer.from(text, "utf8") };
}
function isLinkEntry(entry) {
  return "ref" in entry;
}
async function sameFileBytes(aPath, bPath) {
  const sizes = await Promise.all([stat(aPath), stat(bPath)]);
  if (sizes[0].size !== sizes[1].size) return false;
  const [a, b] = await Promise.all([open(aPath, "r"), open(bPath, "r")]);
  try {
    const aChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    const bChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    for (; ; ) {
      const [ra, rb] = await Promise.all([
        a.read(aChunk, 0, COMPARE_CHUNK_BYTES, null),
        b.read(bChunk, 0, COMPARE_CHUNK_BYTES, null)
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!aChunk.subarray(0, ra.bytesRead).equals(bChunk.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}
async function sameFileBuffer(path, bytes) {
  const st = await stat(path);
  if (st.size !== bytes.length) return false;
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    let offset = 0;
    for (; ; ) {
      const read = await handle.read(chunk, 0, Math.min(COMPARE_CHUNK_BYTES, bytes.length - offset), offset);
      if (read.bytesRead === 0) return offset === bytes.length;
      if (!chunk.subarray(0, read.bytesRead).equals(bytes.subarray(offset, offset + read.bytesRead))) return false;
      offset += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
}
function isEnoent(error) {
  return error?.code === "ENOENT";
}
var defaultProbe = {
  async matches(source, path) {
    try {
      if (source === null) {
        await stat(path);
        return false;
      }
      if (source.kind === "blob") return await sameFileBytes(path, source.path);
      if (source.kind === "text") return await sameFileBuffer(path, source.bytes);
      return (await readFile(path)).toString("utf8") === source.text;
    } catch (error) {
      if (isEnoent(error)) return source === null ? true : false;
      return void 0;
    }
  },
  async copy(path, dest) {
    try {
      await copyFile(path, dest);
      const st = await stat(dest);
      return { kind: "copied", size: st.size };
    } catch (error) {
      if (isEnoent(error)) {
        const source = await stat(path).catch(() => void 0);
        if (source === void 0) return { kind: "absent" };
      }
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  },
  async size(path) {
    try {
      const st = await stat(path);
      return st.isFile() ? st.size : void 0;
    } catch {
      return void 0;
    }
  },
  isLink: isLinkPath
};
function safeFileId(callId) {
  return callId.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function safeSessionId(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe === ".." || safe === "." ? "session" : safe;
}
async function writeJsonAtomic(file, data, afterTempWrite) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  afterTempWrite?.();
  await rename(tmp, file);
}
var RESTORE_JOURNAL_STATES = /* @__PURE__ */ new Set(["running", "rollback-running", "completed", "rolled-back", "recovery-required"]);
function isRawJournalRef(value) {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value !== "object") return false;
  const ref = value;
  return typeof ref.blob === "string" || typeof ref.text === "string";
}
function isRestoreJournal(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  if (typeof v.id !== "string" || typeof v.sessionId !== "string" || typeof v.targetSeq !== "number") return false;
  if (v.version !== void 0 && v.version !== 1 && v.version !== 2) return false;
  if (typeof v.state !== "string" || !RESTORE_JOURNAL_STATES.has(v.state)) return false;
  if (!Array.isArray(v.actions)) return false;
  return v.actions.every((action) => {
    if (typeof action !== "object" || action === null) return false;
    const a = action;
    if (typeof a.path !== "string" || a.action !== "restore" && a.action !== "delete") return false;
    if (typeof a.done !== "boolean") return false;
    if (!isRawJournalRef(a.before) || !isRawJournalRef(a.rescue)) return false;
    if (a.action === "restore" && a.before === null) return false;
    return true;
  });
}
function refToSource(raw, sessionDir) {
  if (raw === null) return null;
  if (typeof raw === "string") return textSourceOf(raw);
  if (typeof raw !== "object") return void 0;
  const ref = raw;
  if (typeof ref.blob === "string") {
    if (!isSafeBackupRef(ref.blob)) return void 0;
    return { kind: "blob", path: join(sessionDir, ref.blob) };
  }
  if (typeof ref.text === "string") return textSourceOf(ref.text);
  return void 0;
}
function sourceToRef(source, sessionDir, entryPath) {
  if (source === null) return null;
  if (source.kind === "blob") {
    const blob = relative(sessionDir, source.path);
    if (!isSafeBackupRef(blob)) throw new Error(`unsafe backup ref ${blob} for ${entryPath}`);
    return { blob };
  }
  return { text: source.kind === "text" ? source.bytes.toString("utf8") : source.text };
}
function journalToJson(journal, sessionDir) {
  return {
    version: 2,
    id: journal.id,
    sessionId: journal.sessionId,
    targetSeq: journal.targetSeq,
    startedAt: journal.startedAt,
    ...journal.finishedAt !== void 0 ? { finishedAt: journal.finishedAt } : {},
    state: journal.state,
    actions: journal.actions.map((action) => ({
      path: action.path,
      action: action.action,
      before: sourceToRef(action.before, sessionDir, action.path),
      rescue: sourceToRef(action.rescue, sessionDir, action.path),
      ...action.rescueError !== void 0 ? { rescueError: action.rescueError } : {},
      ...action.mode !== void 0 ? { mode: action.mode } : {},
      ...action.rescueMode !== void 0 ? { rescueMode: action.rescueMode } : {},
      ...action.parent !== void 0 ? { parent: action.parent } : {},
      done: action.done,
      ...action.failed !== void 0 ? { failed: action.failed } : {}
    })),
    ...journal.rollbackError !== void 0 ? { rollbackError: journal.rollbackError } : {}
  };
}
function journalFromJson(raw, sessionDir) {
  const actions = [];
  for (const value of raw.actions) {
    const before = refToSource(value.before, sessionDir);
    const rescue = refToSource(value.rescue, sessionDir);
    if (before === void 0 || rescue === void 0) return void 0;
    actions.push({
      path: value.path,
      action: value.action,
      before: value.action === "delete" ? null : before,
      rescue,
      ...typeof value.rescueError === "string" ? { rescueError: value.rescueError } : {},
      ...typeof value.mode === "number" ? { mode: value.mode } : {},
      ...typeof value.rescueMode === "number" ? { rescueMode: value.rescueMode } : {},
      ...typeof value.parent === "string" && value.parent.length > 0 ? { parent: value.parent } : {},
      done: value.done,
      ...typeof value.failed === "string" ? { failed: value.failed } : {}
    });
  }
  const version = raw.version === 1 ? 1 : 2;
  return {
    version,
    id: raw.id,
    sessionId: raw.sessionId,
    targetSeq: raw.targetSeq,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
    ...typeof raw.finishedAt === "number" ? { finishedAt: raw.finishedAt } : {},
    state: raw.state,
    actions,
    ...typeof raw.rollbackError === "string" ? { rollbackError: raw.rollbackError } : {}
  };
}
function isJournalName(name2) {
  if (!name2.endsWith(".json")) return false;
  return name2.startsWith(JOURNAL_PREFIX) || name2.startsWith(LEGACY_JOURNAL_PREFIX);
}
function journalOpIdOf(name2) {
  const prefix = name2.startsWith(LEGACY_JOURNAL_PREFIX) ? LEGACY_JOURNAL_PREFIX : JOURNAL_PREFIX;
  return name2.slice(prefix.length, -".json".length);
}
function entryFileName(callId) {
  return `${safeFileId(callId)}-${shortHash(callId)}.json`;
}
function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
function sidecarName(entryFile) {
  return `${entryFile.slice(0, -".json".length)}${SIDECAR_SUFFIX}`;
}
function refAnchorOf(ref) {
  const slash = ref.indexOf("/");
  return slash === -1 ? Number.NaN : Number(ref.slice(0, slash));
}
function entryToJson(entry) {
  const base = {
    store: 2,
    callId: entry.callId,
    file: entry.path,
    time: entry.time,
    ...entry.parent !== void 0 ? { parent: entry.parent } : {},
    ...entry.mode !== void 0 ? { mode: entry.mode } : {},
    ...entry.lossy === true ? { lossy: true } : {}
  };
  if (entry.before === null) return { ...base, blob: null, size: 0 };
  if (entry.before.kind !== "blob") throw new Error(`entry for ${entry.path} is not blob-backed`);
  return { ...base, blob: basename(entry.before.path), size: entry.size };
}
function linkToJson(link) {
  return {
    store: 2,
    callId: link.callId,
    file: link.path,
    ref: link.ref,
    time: link.time,
    ...link.parent !== void 0 ? { parent: link.parent } : {}
  };
}
async function readEntry(file, anchorSeq) {
  let parsed;
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (typeof value !== "object" || value === null) return void 0;
    parsed = value;
  } catch {
    return void 0;
  }
  if (typeof parsed.store === "number" && parsed.store > CURRENT_STORE_VERSION) {
    throw new UnknownStoreVersionError(parsed.store, file);
  }
  const callId = String(parsed.callId ?? "");
  const time = typeof parsed.time === "number" ? parsed.time : 0;
  const origin = { file };
  if (parsed.store === 2) {
    if (typeof parsed.file !== "string") return void 0;
    const parent = typeof parsed.parent === "string" && parsed.parent.length > 0 ? parsed.parent : void 0;
    const base2 = { callId, anchorSeq, path: parsed.file, time, ...parent !== void 0 ? { parent } : {}, ...origin };
    if (typeof parsed.ref === "string") return { ...base2, ref: parsed.ref };
    if (parsed.blob === null) {
      if (parsed.lossy === true) return void 0;
      if (typeof parsed.size === "number" && parsed.size !== 0) return void 0;
      return { ...base2, before: null, size: 0 };
    }
    if (typeof parsed.blob !== "string") return void 0;
    if (parsed.blob !== sidecarName(basename(file))) return void 0;
    const size = typeof parsed.size === "number" && parsed.size >= 0 ? parsed.size : 0;
    const mode = typeof parsed.mode === "number" ? parsed.mode : void 0;
    if (parsed.lossy === true) {
      try {
        const text = await readFile(join(dirname(file), parsed.blob), "utf8");
        return { ...base2, before: { kind: "lossyText", text }, size, lossy: true, ...mode !== void 0 ? { mode } : {} };
      } catch {
        return void 0;
      }
    }
    return {
      ...base2,
      before: { kind: "blob", path: join(dirname(file), parsed.blob) },
      size,
      ...mode !== void 0 ? { mode } : {}
    };
  }
  if (typeof parsed.path !== "string" || typeof parsed.anchorSeq !== "number") return void 0;
  const base = { callId, anchorSeq: parsed.anchorSeq, path: parsed.path, time, ...origin };
  if (typeof parsed.ref === "string") return { ...base, ref: parsed.ref };
  if (parsed.before !== null && typeof parsed.before !== "string") return void 0;
  if (parsed.before === null) return { ...base, before: null, size: 0 };
  return { ...base, before: textSourceOf(parsed.before), size: Buffer.byteLength(parsed.before, "utf8") };
}
async function dirBytes(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name2 of names) {
    const full = join(dir, name2);
    const st = await lstat(full).catch(() => void 0);
    if (st === void 0) continue;
    if (st.isDirectory()) total += await dirBytes(full);
    else if (st.isFile()) total += st.size;
  }
  return total;
}
async function isLinkPath(path) {
  try {
    const stat3 = await lstat(path);
    return stat3.isSymbolicLink() || stat3.nlink > 1;
  } catch {
    return false;
  }
}
async function nearestExistingAncestor(dir) {
  let current = dir;
  for (; ; ) {
    const st = await lstat(current).catch(() => void 0);
    if (st !== void 0) return current;
    const parent = dirname(current);
    if (parent === current) return void 0;
    current = parent;
  }
}
async function parentStillMatches(path, recorded) {
  if (recorded === void 0) return true;
  const dir = dirname(path);
  try {
    return await realpath(dir) === recorded;
  } catch (error) {
    if (!isEnoent(error)) return false;
  }
  const ancestor = await nearestExistingAncestor(dir);
  if (ancestor === void 0) return false;
  try {
    const real = await realpath(ancestor);
    const inside = relative(real, recorded);
    const escapes = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    return inside !== "" && !escapes;
  } catch {
    return false;
  }
}
function isSafeLinkRef(ref) {
  return /^[0-9]+\/[a-zA-Z0-9._-]+\.json$/.test(ref);
}
function isSafeBackupRef(ref) {
  if (ref.length === 0 || ref.startsWith("/") || ref.includes("\\")) return false;
  const segments = ref.split("/");
  if (segments.length !== 2 && segments.length !== 3) return false;
  if (segments.length === 3 && segments[0] !== RESCUE_DIR) return false;
  return segments.every((segment) => segment !== "." && segment !== ".." && /^[a-zA-Z0-9._-]+$/.test(segment));
}
async function dirSizeAndLastActive(dir) {
  let size = 0;
  let lastActiveMs = 0;
  const visit = async (current) => {
    let st;
    try {
      st = await lstat(current);
    } catch {
      return;
    }
    if (st.mtimeMs > lastActiveMs) lastActiveMs = st.mtimeMs;
    if (!st.isDirectory()) {
      size += st.size;
      return;
    }
    let names;
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name2 of names) {
      if (name2.startsWith(".") && name2 !== PENDING_DIR) continue;
      await visit(join(current, name2));
    }
  };
  await visit(dir);
  return { size, lastActiveMs };
}
var SnapshotStore = class _SnapshotStore {
  /** Debounce window for the per-commit prune (keeps the readdir+sort off the hot path). */
  static PRUNE_INTERVAL_MS = 1e3;
  /** Session-format-version marker file inside the session dir. Non-`.json`, so it never counts as a checkpoint entry. */
  static FORMAT_FILE = "format";
  /** Plugin STORE-format marker file inside the session dir (non-`.json`, same reasoning). */
  static STORE_FILE = "store";
  lastPruneAt = 0;
  /**
   * Monotonic entry clock. Date.now() has 1ms precision, so back-to-back
   * commits in the same millisecond would TIE on the entry `time` field and
   * entriesAfter's (anchorSeq, time) sort would fall back to the readdir
   * order — filesystem-dependent, so a re-read could pick the WRONG "earliest"
   * version for a path. Bumping past the previous commit keeps the capture
   * order reproducible after a re-read. The read-modify-write below is
   * synchronous (before the first await), so concurrent commits can never
   * observe the same value. Across restarts wall-clock monotonicity holds
   * (restart gaps dwarf 1ms); a backwards NTP step is the only way to break
   * it, and even then the in-process order still holds.
   */
  lastEntryTime = 0;
  /** Store options; `dedup` toggles in-place content dedup (default on). */
  dedup;
  /**
   * Per-file backup cap in bytes; `<= 0` means no cap. Capture paths consult it
   * and the restore planner refuses a pre-cap record over an over-cap file.
   */
  maxFileBytes;
  /**
   * Newest anchor groups (user messages) kept per session; `prune` evicts past
   * this bound. A `Config` field (`maxAnchorGroups`).
   */
  maxAnchorGroups;
  /** Resolved checkpoint store root (absolute); see the constructor's fallback. */
  root;
  /**
   * In-memory per-path "most recent entry" for content dedup, keyed by
   * `<sessionId>\0<path>`. Each value holds the entry's effective byte source
   * (a handle, not a copy) and its own file ref, so a new record with the same
   * content links to the immediately-prior entry (linear chain). Seeded lazily
   * per session from the bounded on-disk window, so dedup survives a host
   * restart. A handle whose bytes vanished (pruned out of band) is treated as
   * "never recorded" — dedup then stores MORE, never less.
   */
  lastEntry = /* @__PURE__ */ new Map();
  /** Sessions whose dedup state has been seeded from disk this process. */
  seededSessions = /* @__PURE__ */ new Set();
  /** Sessions whose store-format marker this process has already stamped. */
  storeStamped = /* @__PURE__ */ new Set();
  /**
   * Session-format version snapshots are anchored under, stamped into each
   * session's `format` marker when an entry is recorded. `null` until the host
   * sets it (from `agent/created`), so a session that never records is
   * never materialized and a marker is only written where snapshots exist.
   */
  formatVersion = null;
  constructor(root, opts) {
    this.dedup = opts?.dedup ?? true;
    this.maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxAnchorGroups = opts?.maxAnchorGroups ?? MAX_ANCHOR_GROUPS;
    this.root = root ?? join(resolveDshHome(opts?.dshHome), SNAPSHOT_DIR_NAME);
  }
  /** Absolute path of one session's snapshot directory (id sanitized). */
  sessionDir(sessionId) {
    return join(this.root, safeSessionId(sessionId));
  }
  /**
   * True when `size` bytes is over the per-file cap, so it must not be backed
   * up. `undefined` (a backend that cannot report a size) answers false: the
   * guard fails toward STORING, never toward calling a file too big on a guess.
   */
  isOverFileCap(size) {
    return this.maxFileBytes > 0 && size !== void 0 && size > this.maxFileBytes;
  }
  /** The cap in force, for reporting (0 = unlimited). */
  get fileCapBytes() {
    return this.maxFileBytes;
  }
  /** Absolute path of one anchor group directory. */
  anchorDir(sessionId, anchorSeq) {
    return join(this.sessionDir(sessionId), String(anchorSeq));
  }
  /** Absolute file ref (relative to the session dir) of an entry. */
  entryRefOf(sessionId, callId, anchorSeq) {
    return `${anchorSeq}/${entryFileName(callId)}`;
  }
  /**
   * The session-relative ref of an entry READ from disk: the file that really
   * holds it. A v1 entry keeps its released name, so recomputing the name from
   * the call id would produce a dangling reference.
   */
  refOfRead(sessionId, entry) {
    if (entry.file !== void 0) return relative(this.sessionDir(sessionId), entry.file);
    return this.entryRefOf(sessionId, entry.callId, entry.anchorSeq);
  }
  /** Drop every in-memory trace of one session (its directory is gone). */
  forgetSession(sessionId) {
    this.seededSessions.delete(sessionId);
    this.storeStamped.delete(sessionId);
    for (const key of [...this.lastEntry.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key);
    }
  }
  /**
   * Forget in-memory state for sessions whose directory no longer exists —
   * after a sweep, or after the user removed a session dir out of band. A
   * stale handle is SAFE (dedup and the boundary both fail toward storing
   * more), but keeping it means the store holds state for a session it deleted
   * and skips re-stamping that session's `format`/`store` markers.
   */
  async forgetMissingSessions() {
    const known = /* @__PURE__ */ new Set([...this.seededSessions, ...this.storeStamped]);
    for (const key of this.lastEntry.keys()) {
      const separator = key.indexOf("\0");
      if (separator !== -1) known.add(key.slice(0, separator));
    }
    for (const sessionId of known) {
      const present = await this.exists(this.sessionDir(sessionId)).catch(() => true);
      if (!present) this.forgetSession(sessionId);
    }
  }
  /**
   * Stage a capture slot for one tool call: create the session's `.pending/`
   * area and return the absolute path the caller copies the before-bytes into
   * (never through memory). The slot lives inside the session dir so the
   * commit can `rename` it into the anchor group atomically; a slot that is
   * never committed is either unlinked by its caller or collected by `prune`.
   */
  async stageCapture(sessionId, key) {
    const dir = join(this.sessionDir(sessionId), PENDING_DIR);
    await mkdir(dir, { recursive: true });
    return join(dir, `${safeFileId(key)}-${shortHash(key)}${SIDECAR_SUFFIX}`);
  }
  /**
   * Seed a session's dedup state from the existing (bounded) on-disk window:
   * scan entries newest-first and record the most recent entry per path. This
   * makes content dedup survive a host restart within the session window. A
   * no-op after the first seed (or when `dedup` is disabled).
   */
  async ensureDedupSeeded(sessionId) {
    if (!this.dedup || this.seededSessions.has(sessionId)) return;
    this.seededSessions.add(sessionId);
    try {
      for (const entry of await this.entriesAfter(sessionId, 0)) {
        const key = `${sessionId}\0${entry.path}`;
        if (this.lastEntry.has(key)) continue;
        const source = await this.resolveBefore(sessionId, entry);
        this.lastEntry.set(key, { source, ref: this.refOfRead(sessionId, entry) });
      }
    } catch {
      this.seededSessions.delete(sessionId);
    }
  }
  /**
   * Resolve an entry's effective `before` content, following a link chain to
   * its terminal real snapshot. Refs are strictly backward in
   * `(anchorSeq, time)`, so the chain is acyclic and finite. A dangling or
   * cyclic link throws — callers fail per-file (never silently dropping the
   * path from a restore).
   */
  async resolveBefore(sessionId, entry, seen = /* @__PURE__ */ new Set()) {
    if (!isLinkEntry(entry)) return this.validatedSource(entry);
    const key = `${entry.anchorSeq}:${entry.callId}`;
    if (seen.has(key)) throw new Error(`link cycle at ${entry.path} (${key})`);
    seen.add(key);
    if (!isSafeLinkRef(entry.ref)) throw new Error(`unsafe link ref ${entry.ref} for ${entry.path}`);
    const referenced = await readEntry(join(this.sessionDir(sessionId), entry.ref), refAnchorOf(entry.ref));
    if (referenced === void 0) throw new Error(`dangling link ${entry.ref} for ${entry.path}`);
    return this.resolveBefore(sessionId, referenced, seen);
  }
  /**
   * Validate a real entry's byte source against the store's own files: a
   * sidecar that is missing, not a regular file, or a different size than the
   * metadata records is an INTEGRITY failure (thrown), never a silent skip and
   * never a fallback to "the file was created" — a restore must not delete a
   * file whose backup it cannot read.
   */
  async validatedSource(entry) {
    const source = entry.before;
    if (source === null || source.kind !== "blob") return source;
    const st = await stat(source.path).catch((error) => {
      if (isEnoent(error)) throw new Error(`missing backup sidecar ${source.path} for ${entry.path}`);
      throw error;
    });
    if (!st.isFile()) throw new Error(`backup sidecar is not a file: ${source.path}`);
    if (st.size !== entry.size) {
      throw new Error(`backup sidecar size mismatch for ${entry.path} (recorded ${entry.size}, found ${st.size})`);
    }
    return source;
  }
  /**
   * True when two recorded byte sources are the same content. Comparison is
   * STREAMING (size first, then chunks) so large files never enter memory.
   * Any unreadable handle — or any legacy lossy source, whose original bytes
   * are unknowable — answers `false`: dedup must fail toward storing more,
   * never toward claiming "unchanged".
   */
  async sourcesMatch(a, b) {
    if (a === null || b === null) return a === null && b === null;
    try {
      if (a.kind === "blob" && b.kind === "blob") return await sameFileBytes(a.path, b.path);
      if (a.kind === "text" && b.kind === "text") return a.bytes.equals(b.bytes);
      if (a.kind === "blob" && b.kind === "text") return await sameFileBuffer(a.path, b.bytes);
      if (a.kind === "text" && b.kind === "blob") return await sameFileBuffer(b.path, a.bytes);
      return false;
    } catch {
      return false;
    }
  }
  /**
   * Write raw bytes to a sidecar path atomically (temp + rename): a crash
   * between the steps leaves only a `.tmp` that no reader picks up.
   */
  async writeSidecar(dest, source) {
    const tmp = `${dest}.tmp`;
    if (source.kind === "blob") await copyFile(source.path, tmp);
    else if (source.kind === "text") await writeFile(tmp, source.bytes);
    else await writeFile(tmp, Buffer.from(source.text, "utf8"));
    await rename(tmp, dest);
  }
  /**
   * Place one entry's sidecar next to its entry file: MOVE a staged capture
   * (same filesystem, atomic) or write the bytes from a source. Returns the
   * blob source and its size, or null for a created file. The sidecar is
   * always complete before the entry JSON is written.
   */
  async placeSidecar(entryFile, content) {
    if (content.source === null) return null;
    const dest = join(dirname(entryFile), sidecarName(basename(entryFile)));
    if (content.staged !== void 0) await rename(content.staged.file, dest);
    else await this.writeSidecar(dest, content.source);
    const st = await stat(dest);
    return { source: { kind: "blob", path: dest }, size: st.size };
  }
  /**
   * Commit one entry (a full before-backup or an in-place dedup link) under
   * its anchor group.
   */
  async commit(sessionId, entry, content, opts) {
    const time = Math.max(Date.now(), this.lastEntryTime + 1);
    this.lastEntryTime = time;
    const parent = await realpath(dirname(entry.path)).catch(() => void 0);
    await this.ensureDedupSeeded(sessionId);
    await this.assertKnownStoreVersion(sessionId);
    const dir = this.anchorDir(sessionId, entry.anchorSeq);
    await mkdir(dir, { recursive: true });
    const file = join(dir, entryFileName(entry.callId));
    const selfRef = this.entryRefOf(sessionId, entry.callId, entry.anchorSeq);
    const key = `${sessionId}\0${entry.path}`;
    const prior = this.lastEntry.get(key);
    const incoming = content.source === null ? null : content.staged !== void 0 ? { kind: "blob", path: content.staged.file } : content.source;
    const link = this.dedup && opts?.dedup !== false && prior !== void 0 && await this.sourcesMatch(prior.source, incoming);
    if (link) {
      const committed = {
        callId: entry.callId,
        anchorSeq: entry.anchorSeq,
        path: entry.path,
        ref: prior.ref,
        ...parent !== void 0 ? { parent } : {},
        time
      };
      if (content.staged !== void 0) await rm(content.staged.file, { force: true });
      await writeJsonAtomic(file, linkToJson(committed), () => opts?.crash?.("after-temp-write"));
      this.lastEntry.set(key, { source: prior.source, ref: selfRef });
    } else {
      const placed = await this.placeSidecar(file, content);
      const committed = {
        callId: entry.callId,
        anchorSeq: entry.anchorSeq,
        path: entry.path,
        before: placed?.source ?? null,
        size: placed?.size ?? 0,
        // Content that was already lossy when it reached the store (a v1
        // string, or a materialized link to one) stays marked, so a later
        // reader cannot mistake its re-encoded bytes for a faithful backup.
        ...incoming?.kind === "lossyText" ? { lossy: true } : {},
        ...content.mode !== void 0 ? { mode: content.mode } : {},
        ...parent !== void 0 ? { parent } : {},
        time
      };
      await writeJsonAtomic(file, entryToJson(committed), () => opts?.crash?.("after-temp-write"));
      this.lastEntry.set(key, { source: committed.before, ref: selfRef });
    }
    if (this.formatVersion !== null) {
      await this.markFormatVersion(sessionId, this.formatVersion);
    }
    if (!this.storeStamped.has(sessionId)) {
      await this.markStoreVersion(sessionId, CURRENT_STORE_VERSION);
      this.storeStamped.add(sessionId);
    }
    const now = Date.now();
    if (now - this.lastPruneAt >= _SnapshotStore.PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now;
      await this.prune(sessionId);
    }
  }
  /**
   * Commit one before-backup whose content the caller already holds as raw
   * text (the boundary-friendly API: tests, synthetic records). The bytes are
   * encoded UTF-8, exactly as the released v1 build did for text content.
   */
  async recordEntry(sessionId, entry, opts) {
    await this.commit(sessionId, entry, {
      source: entry.before === null ? null : textSourceOf(entry.before)
    }, opts);
  }
  /**
   * Commit one before-backup whose content is an existing byte file (the
   * capture and boundary paths): `backup.file` is MOVED into the anchor group
   * (same filesystem, so this is atomic), or `null` when the file did not
   * exist — a creation.
   */
  async recordBackup(sessionId, entry, backup, opts) {
    await this.commit(sessionId, entry, {
      source: backup === null ? null : { kind: "blob", path: backup.file },
      ...backup !== null ? { staged: { file: backup.file } } : {},
      ...backup?.mode !== void 0 ? { mode: backup.mode } : {}
    }, opts);
  }
  /**
   * The byte source recorded by the path's MOST RECENT entry, or undefined
   * when the path has never been recorded (a fresh tracking sight). This is
   * the single in-memory "last known state" the boundary compares the disk
   * against — the same source `recordEntry` dedups against, so there is one
   * handle and one comparison per decision, not two. Seeding is idempotent
   * (once per session from disk).
   */
  async lastKnownContent(sessionId, path) {
    await this.ensureDedupSeeded(sessionId);
    return this.lastEntry.get(`${sessionId}\0${path}`)?.source;
  }
  /**
   * All committed entries anchored at or after `targetSeq`, newest first (for
   * preview ordering). The boundary is inclusive: rewinding to a message also
   * reverts the changes its own turn caused (the rewind cut removes that
   * turn's assistant response and tool calls), so only entries anchored at
   * earlier messages survive.
   */
  async entriesAfter(sessionId, targetSeq) {
    const sessionDir = this.sessionDir(sessionId);
    let names;
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const entries = [];
    for (const name2 of names) {
      const anchorSeq = Number(name2);
      if (!Number.isSafeInteger(anchorSeq) || anchorSeq < targetSeq) continue;
      const files = await readdir(this.anchorDir(sessionId, anchorSeq)).catch(() => []);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const entry = await readEntry(join(this.anchorDir(sessionId, anchorSeq), file), anchorSeq);
        if (entry !== void 0) entries.push(entry);
      }
    }
    return entries.sort((a, b) => b.anchorSeq - a.anchorSeq || b.time - a.time);
  }
  /**
   * Per-path EARLIEST committed entry anchored at or after the target — the
   * single source of truth for both restore and impact preview.
   */
  async earliestEntries(sessionId, targetSeq) {
    const earliest = /* @__PURE__ */ new Map();
    for (const entry of await this.entriesAfter(sessionId, targetSeq)) {
      const current = earliest.get(entry.path);
      if (current === void 0 || entry.anchorSeq < current.anchorSeq || entry.anchorSeq === current.anchorSeq && entry.time < current.time) {
        earliest.set(entry.path, entry);
      }
    }
    return earliest;
  }
  /**
   * The single source of truth for BOTH the impact preview and the restore
   * pass: reconcile the earliest recorded entry per path (at/after the
   * target) against the CURRENT on-disk state, and plan only the actions
   * that would actually change the disk. This is the Claude Code model —
   * `fileHistoryGetDiffStats` / `applySnapshot` both compare against the
   * live filesystem (`checkOriginFileChanged`) and count only real
   * differences, so a rewind whose target state already matches the disk is
   * a no-op with zero impact.
   *
   * - `before === null` (the file did not exist at the target) plans a
   *   `delete` ONLY when the file currently exists; an already-absent file
   *   is a no-op — this kills the "ghost impact" of replaying an entry a
   *   previous rewind already consumed.
   * - a recorded byte source plans a `restore` ONLY when the current bytes
   *   differ from it (or the file is missing); identical bytes are a no-op —
   *   this keeps repeated rewinds idempotent.
   * - A released-v1 record that lost bytes to a lossy decode (`lossyText`) is
   *   compared with the same lossy decode but NEVER written back: a skip is
   *   reported instead of destroying live bytes with U+FFFD content.
   * - An unreadable / unresolvable record is a per-file FAILURE, never a
   *   delete: planning a delete for a file we cannot restore is the one
   *   mistake that loses data.
   * - Symlinked / hard-linked paths are never planned (they are reported as
   *   skipped by the restore pass, never written through).
   * - A probe failure (e.g. a permission error reading the file) plans the
   *   action conservatively as if the file differed, so an unreadable file
   *   is never silently dropped from the restore.
   *
   * @param sessionId - session whose snapshot store to plan against.
   * @param targetSeq - rewind target; entries anchored at/after it apply.
   * @param probe - current-disk state probe (defaults to the real FS).
   * @returns the planned actions, the link paths skipped, and per-file failures.
   */
  async planRestore(sessionId, targetSeq, probe) {
    await this.assertKnownStoreVersion(sessionId);
    const actions = [];
    const skipped = [];
    const failed = [];
    for (const entry of (await this.earliestEntries(sessionId, targetSeq)).values()) {
      let source;
      try {
        source = await this.resolveBefore(sessionId, entry);
      } catch (error) {
        failed.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      try {
        if (await probe.isLink(entry.path)) {
          skipped.push(entry.path);
          continue;
        }
        if (!await parentStillMatches(entry.path, entry.parent)) {
          skipped.push(entry.path);
          continue;
        }
        if (probe.size !== void 0 && this.isOverFileCap(await probe.size(entry.path))) {
          skipped.push(entry.path);
          continue;
        }
        if (source !== null && source.kind === "lossyText") {
          const same2 = await probe.matches(source, entry.path);
          if (same2 !== true) skipped.push(entry.path);
          continue;
        }
        const same = await probe.matches(source, entry.path);
        if (same === true) continue;
        const pin = entry.parent !== void 0 ? { parent: entry.parent } : {};
        if (source === null) actions.push({ path: entry.path, action: "delete", ...pin });
        else {
          const mode = isLinkEntry(entry) ? void 0 : entry.mode;
          actions.push({
            path: entry.path,
            action: "restore",
            before: source,
            ...mode !== void 0 ? { mode } : {},
            ...pin
          });
        }
      } catch {
        if (source !== null && source.kind === "lossyText") {
          skipped.push(entry.path);
          continue;
        }
        const pin = entry.parent !== void 0 ? { parent: entry.parent } : {};
        if (source === null) actions.push({ path: entry.path, action: "delete", ...pin });
        else actions.push({ path: entry.path, action: "restore", before: source, ...pin });
      }
    }
    return { actions, skipped, failed };
  }
  /** Per-file restore impact: only actions that would actually change the disk. */
  async impactsAfter(sessionId, targetSeq, probe = defaultProbe) {
    const { actions } = await this.planRestore(sessionId, targetSeq, probe);
    return actions.sort((a, b) => a.path.localeCompare(b.path)).map((action) => ({ path: action.path, action: action.action }));
  }
  /**
   * Restore the workspace to the target message's checkpoint: execute exactly
   * the actions {@link planRestore} derived from the record + current disk
   * reconciliation — write the before content back, or delete the file when
   * it was created after the target and still exists. Symlinked and
   * hard-linked paths are skipped (reported, never written through); a
   * restored file's parent directory is created when it was deleted after
   * the backup; a delete whose file is ALREADY absent is a silent no-op (not
   * a failure — the target state is already reached). Failures are per-file
   * and never abort the pass.
   *
   * The pass is journaled for crash safety: the pre-restore ("rescue") state
   * of every planned path is captured and an intent journal persisted BEFORE
   * any mutation, then each action is marked done as it is applied. A host
   * crash at any point leaves the journal on disk; after a restart
   * {@link reconcileRestores} reports where the restore stopped,
   * {@link continueRestore} finishes it and {@link rollbackRestore} undoes it
   * back to the exact pre-restore state. Journal IO itself never fails the
   * restore (it degrades to a journal-less pass).
   */
  async restoreAfter(sessionId, targetSeq, deleteFile, probe = defaultProbe, opts) {
    const restored = [];
    const deleted = [];
    const skipped = [];
    const failed = [];
    const { actions, skipped: skippedPaths, failed: planFailed } = await this.planRestore(sessionId, targetSeq, probe);
    skipped.push(...skippedPaths);
    failed.push(...planFailed);
    if (actions.length === 0) return { restored, deleted, skipped, failed };
    const journal = await this.beginRestore(sessionId, targetSeq, actions, probe);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      opts?.crash?.("before-action", i);
      const journalAction = journal.actions[i];
      let applied;
      try {
        applied = await this.applyActionToDisk(
          action.action,
          action.path,
          action.action === "restore" ? action.before : null,
          deleteFile,
          {
            ...action.action === "restore" && action.mode !== void 0 ? { mode: action.mode } : {},
            ...action.parent !== void 0 ? { parent: action.parent } : {}
          }
        );
        if (applied === "skipped") {
          journalAction.failed = `parent directory moved or repointed: ${dirname(action.path)}`;
          await this.saveJournal(journal);
          failed.push({ path: action.path, message: journalAction.failed });
          continue;
        }
        if (applied === "enoent") {
          journalAction.done = true;
          await this.saveJournal(journal);
          continue;
        }
      } catch (error) {
        journalAction.failed = error instanceof Error ? error.message : String(error);
        await this.saveJournal(journal);
        failed.push({ path: action.path, message: journalAction.failed });
        continue;
      }
      opts?.crash?.("after-action", i);
      journalAction.done = true;
      await this.saveJournal(journal);
      if (applied === "restored") restored.push(action.path);
      else deleted.push(action.path);
    }
    if (failed.length === 0) {
      journal.state = "completed";
      journal.finishedAt = Date.now();
    }
    await this.saveJournal(journal);
    return { restored, deleted, skipped, failed };
  }
  /** Absolute path of one restore-op journal file (the current prefix). */
  journalPath(sessionId, opId) {
    return join(this.sessionDir(sessionId), `${JOURNAL_PREFIX}${safeFileId(opId)}.json`);
  }
  /**
   * Locate an existing journal file for an op: the current prefix first, then
   * the prefix the released v1 build wrote (a restore interrupted before the
   * upgrade must still be continuable / rollbackable).
   */
  async findJournalFile(sessionId, opId) {
    const dir = this.sessionDir(sessionId);
    for (const name2 of [`${JOURNAL_PREFIX}${safeFileId(opId)}.json`, `${LEGACY_JOURNAL_PREFIX}${safeFileId(opId)}.json`]) {
      const file = join(dir, name2);
      try {
        await stat(file);
        return file;
      } catch {
        continue;
      }
    }
    return void 0;
  }
  /**
   * Best-effort journal persist: journal IO failures are non-fatal by design —
   * a restore must never fail because its audit journal could not be written.
   * reconcileRestores() re-derives the true state from the disk, so a missing
   * or stale journal only loses the trail, never the recovery ability.
   *
   * A journal read back from a legacy file is rewritten IN PLACE (same file),
   * so a redo / rollback of a pre-upgrade op never leaves two divergent
   * versions of the same op on disk.
   */
  async saveJournal(journal) {
    try {
      const file = journal.sourceFile ?? this.journalPath(journal.sessionId, journal.id);
      await writeJsonAtomic(file, journalToJson(journal, this.sessionDir(journal.sessionId)));
    } catch {
    }
  }
  /**
   * Journal one restore pass before mutating anything: capture the rescue
   * (pre-restore) state of every planned path as a raw byte copy and persist
   * the intent (references only) atomically. Returns the in-memory journal; a
   * persist failure degrades to a journal-less restore (non-fatal, see
   * {@link saveJournal}).
   */
  async beginRestore(sessionId, targetSeq, actions, probe) {
    const sessionDir = this.sessionDir(sessionId);
    try {
      await this.pruneTerminalJournals(sessionDir, await readdir(sessionDir));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const rescueDir = join(sessionDir, RESCUE_DIR, safeFileId(id));
    let rescueDirReady = false;
    const journalActions = [];
    for (const [index, action] of actions.entries()) {
      let rescue = null;
      let rescueError;
      const dest = join(rescueDir, `${index}${SIDECAR_SUFFIX}`);
      try {
        if (!rescueDirReady) {
          await mkdir(rescueDir, { recursive: true });
          rescueDirReady = true;
        }
        const copied = await probe.copy(action.path, dest);
        if (copied.kind === "copied") rescue = { kind: "blob", path: dest };
        else if (copied.kind === "failed") rescueError = copied.message;
      } catch (error) {
        rescueError = error instanceof Error ? error.message : String(error);
      }
      const rescueMode = (await stat(action.path).catch(() => void 0))?.mode;
      const journalAction = {
        path: action.path,
        action: action.action,
        before: action.action === "restore" ? action.before : null,
        rescue,
        ...action.action === "restore" && action.mode !== void 0 ? { mode: action.mode } : {},
        ...action.parent !== void 0 ? { parent: action.parent } : {},
        ...rescueMode !== void 0 ? { rescueMode: rescueMode & 4095 } : {},
        done: false
      };
      if (rescueError !== void 0) journalAction.rescueError = rescueError;
      journalActions.push(journalAction);
    }
    const journal = {
      version: 2,
      id,
      sessionId,
      targetSeq,
      startedAt: Date.now(),
      state: "running",
      actions: journalActions
    };
    await this.saveJournal(journal);
    return journal;
  }
  /**
   * Read one journal by op id; undefined when it does not exist. A corrupt
   * journal THROWS (fail-loud): unlike checkpoint entries, silently dropping
   * a journal would silently erase the interrupted restore's recovery record.
   */
  async readJournal(sessionId, opId) {
    const file = await this.findJournalFile(sessionId, opId);
    if (file === void 0) return void 0;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      throw new Error(`restore journal ${file} is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRestoreJournal(parsed)) throw new Error(`restore journal ${file} failed schema validation`);
    const journal = journalFromJson(parsed, this.sessionDir(sessionId));
    if (journal === void 0) throw new Error(`restore journal ${file} failed schema validation`);
    journal.sourceFile = file;
    return journal;
  }
  /**
   * Every journal file of a session (both prefixes) — valid ones plus corrupt
   * ones with their error — so reconciliation can report corruption instead of
   * dropping it.
   */
  async listJournals(sessionId) {
    const sessionDir = this.sessionDir(sessionId);
    let names;
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if (isEnoent(error)) return { journals: [], corrupt: [] };
      throw error;
    }
    const journals = [];
    const corrupt = [];
    for (const name2 of names) {
      if (!isJournalName(name2)) continue;
      try {
        const parsed = JSON.parse(await readFile(join(sessionDir, name2), "utf8"));
        if (!isRestoreJournal(parsed)) {
          corrupt.push({ file: name2, message: "journal failed schema validation" });
          continue;
        }
        const journal = journalFromJson(parsed, sessionDir);
        if (journal === void 0) {
          corrupt.push({ file: name2, message: "journal references are invalid" });
          continue;
        }
        journal.sourceFile = join(sessionDir, name2);
        journals.push(journal);
      } catch (error) {
        corrupt.push({ file: name2, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { journals, corrupt };
  }
  /**
   * Execute ONE fs mutation with exactly the pre-journal semantics: a delete
   * runs through the injected deleteFile (ENOENT tolerated — the file is
   * already absent, i.e. the target state is reached), a restore copies the
   * recorded bytes back over the file (creating the parent if needed).
   *
   * This is the only place the store writes restored content to the real FS,
   * and it is deliberately raw `copyFile`/`writeFile`/`unlink` rather than the
   * fs service: the caller only ever hands it a path from `planRestore` — one
   * the session's own write-class tool call recorded and resolved (never a
   * symlink/hard link) and only when it differs from the live disk. So no
   * arbitrary path, no model input, never automatic.
   *
   * The write is IN PLACE (no temp + rename): it keeps the file's inode and
   * thus its xattrs/ACL, and crash safety is provided by the journal plus disk
   * reconciliation instead (a half-written file simply does not match the
   * goal, so a redo rewrites it).
   *
   * Permissions are best-effort (ADR-9/R3): the mode is only ever applied as
   * part of a CONTENT restore (never as a reason to plan one), and a chmod
   * failure never fails the restore.
   */
  async applyActionToDisk(kind, path, content, deleteFile, opts) {
    if (!await parentStillMatches(path, opts?.parent)) return "skipped";
    if (kind === "delete") {
      try {
        await deleteFile(path);
        return "deleted";
      } catch (error) {
        if (!isEnoent(error)) throw error;
        return "enoent";
      }
    }
    if (content === null) throw new Error(`restore of ${path} has no recorded content`);
    await mkdir(dirname(path), { recursive: true });
    const current = (await stat(path).catch(() => void 0))?.mode;
    let widened = false;
    if (current !== void 0 && (current & 128) === 0) {
      await chmod(path, current | 128).catch(() => void 0);
      widened = true;
    }
    try {
      if (content.kind === "blob") await copyFile(content.path, path);
      else if (content.kind === "text") await writeFile(path, content.bytes);
      else await writeFile(path, Buffer.from(content.text, "utf8"));
    } catch (error) {
      if (widened && current !== void 0) await chmod(path, current).catch(() => void 0);
      throw error;
    }
    if (opts?.mode !== void 0) await chmod(path, opts.mode).catch(() => void 0);
    else if (widened && current !== void 0) await chmod(path, current).catch(() => void 0);
    return "restored";
  }
  /**
   * Reconcile the session's restore journals against the real disk — the
   * "host restart" account: for every interrupted op, report which paths
   * already match its goal (restored) and which are still pending, and expose
   * any recorded failures. Journals whose goal is already fully reached on
   * disk (e.g. a later rewind completed the work) are auto-healed to their
   * terminal state and not reported. A corrupt journal is reported
   * `recovery-required` — never silently dropped.
   *
   * Deliberately NOT gated on the session's `store` marker: a journal is fully
   * self-describing (`version` plus byte references), and refusing to finish an
   * interrupted op merely because the SESSION marker looks newer would strand a
   * half-restored workspace — the outcome the legacy-journal support exists to
   * prevent. A reference the newer build moved shows up as a per-file failure,
   * never as a silent write.
   *
   * @param sessionId - session whose journals to reconcile.
   * @param probe - current-disk state probe (defaults to the real FS).
   * @returns one report per non-terminal journal still needing attention.
   */
  async reconcileRestores(sessionId, probe = defaultProbe) {
    const { journals, corrupt } = await this.listJournals(sessionId);
    const reports = [];
    for (const bad of corrupt) {
      reports.push({
        opId: journalOpIdOf(bad.file),
        state: "recovery-required",
        journalState: "recovery-required",
        targetSeq: 0,
        startedAt: 0,
        restored: [],
        pending: [],
        failed: [],
        corrupt: bad.message
      });
    }
    for (const journal of journals) {
      if (journal.state === "completed" || journal.state === "rolled-back") continue;
      const report = await this.reconcileJournal(journal, probe);
      if (report !== void 0) reports.push(report);
    }
    return reports.sort((a, b) => a.startedAt - b.startedAt || a.opId.localeCompare(b.opId));
  }
  /**
   * Reconcile ONE non-terminal journal against the real disk. Returns
   * undefined when the op's goal is already fully reached (auto-heals to the
   * terminal state); otherwise a report of restored/pending/failed paths.
   * For `running` journals the goal is the restore target; for
   * `rollback-running` / `recovery-required` journals it is the rescue
   * (pre-restore) state.
   */
  async reconcileJournal(journal, probe) {
    const rollbackPhase = journal.state === "rollback-running" || journal.state === "recovery-required";
    const restored = [];
    const pending = [];
    const failed = [];
    let allReached = true;
    for (const action of journal.actions) {
      if (action.failed !== void 0) {
        failed.push({ path: action.path, message: action.failed });
        allReached = false;
        continue;
      }
      let reached;
      try {
        const goal = rollbackPhase ? action.rescue : action.action === "delete" ? null : action.before;
        reached = await probe.matches(goal, action.path) === true;
      } catch {
        reached = false;
      }
      if (reached) restored.push(action.path);
      else pending.push(action.path);
      if (!reached) allReached = false;
    }
    if (allReached && failed.length === 0) {
      if (rollbackPhase) journal.state = "rolled-back";
      else journal.state = "completed";
      journal.finishedAt = Date.now();
      await this.saveJournal(journal);
      return void 0;
    }
    return {
      opId: journal.id,
      state: journal.state === "recovery-required" ? "recovery-required" : "interrupted",
      journalState: journal.state,
      targetSeq: journal.targetSeq,
      startedAt: journal.startedAt,
      restored,
      pending,
      failed,
      ...journal.rollbackError === void 0 ? {} : { rollbackError: journal.rollbackError }
    };
  }
  /**
   * Continue (redo) an interrupted restore: finish the op by applying every action
   * whose disk state does not yet match its goal — the restore target for
   * `running` journals. Actions are decided by the REAL disk (the same "disk
   * is truth" rule as reconciliation), so a crash between an fs op and its
   * done-mark is completed deterministically and a path the user already
   * fixed is marked done without being rewritten. Failed actions are retried;
   * a re-failure re-records the failure. The journal becomes `completed` once
   * every action reaches the target.
   */
  async continueRestore(sessionId, opId, deleteFile, probe = defaultProbe, opts) {
    const journal = await this.readJournal(sessionId, opId);
    if (journal === void 0) throw new Error(`restore journal ${opId} not found for session ${sessionId}`);
    if (journal.state !== "running") {
      throw new Error(`restore journal ${opId} is in state ${journal.state}; only a running restore can be continued`);
    }
    const restored = [];
    const deleted = [];
    const failed = [];
    for (let i = 0; i < journal.actions.length; i++) {
      const action = journal.actions[i];
      opts?.crash?.("before-action", i);
      let reached;
      try {
        const goal = action.action === "delete" ? null : action.before;
        reached = await probe.matches(goal, action.path) === true;
      } catch {
        reached = false;
      }
      if (reached) {
        action.done = true;
        delete action.failed;
        await this.saveJournal(journal);
        continue;
      }
      let applied;
      try {
        applied = await this.applyActionToDisk(
          action.action,
          action.path,
          action.action === "restore" ? action.before : null,
          deleteFile,
          {
            ...action.action === "restore" && action.mode !== void 0 ? { mode: action.mode } : {},
            ...action.parent !== void 0 ? { parent: action.parent } : {}
          }
        );
        if (applied === "skipped") {
          action.failed = `parent directory moved or repointed: ${dirname(action.path)}`;
          await this.saveJournal(journal);
          failed.push({ path: action.path, message: action.failed });
          continue;
        }
        if (applied === "enoent") {
          action.done = true;
          await this.saveJournal(journal);
          continue;
        }
      } catch (error) {
        action.failed = error instanceof Error ? error.message : String(error);
        await this.saveJournal(journal);
        failed.push({ path: action.path, message: action.failed });
        continue;
      }
      opts?.crash?.("after-action", i);
      action.done = true;
      delete action.failed;
      await this.saveJournal(journal);
      if (applied === "restored") restored.push(action.path);
      else deleted.push(action.path);
    }
    if (journal.actions.every((action) => action.done) && !journal.actions.some((action) => action.failed !== void 0)) {
      journal.state = "completed";
      journal.finishedAt = Date.now();
      await this.saveJournal(journal);
    }
    return { restored, deleted, skipped: [], failed };
  }
  /**
   * Roll back an interrupted restore: undo every action whose disk
   * state does not match its rescue (pre-restore) record, returning the
   * workspace to the exact state it had before the restore started. Decided
   * by the REAL disk, so actions the crash left applied-but-unmarked are
   * undone too, and a path already back at its rescue state is skipped —
   * the pass is idempotent across crashes (a retry finishes the remaining
   * actions). The journal moves `running` → `rollback-running` → `rolled-back`;
   * a failed undo leaves it `recovery-required` (retryable), and paths whose
   * rescue capture failed are reported and left untouched.
   */
  async rollbackRestore(sessionId, opId, deleteFile, probe = defaultProbe, opts) {
    const journal = await this.readJournal(sessionId, opId);
    if (journal === void 0) throw new Error(`restore journal ${opId} not found for session ${sessionId}`);
    if (journal.state === "completed" || journal.state === "rolled-back") {
      throw new Error(`restore journal ${opId} is already ${journal.state}`);
    }
    if (journal.state !== "rollback-running") {
      journal.state = "rollback-running";
      await this.saveJournal(journal);
    }
    const restored = [];
    const deleted = [];
    const failed = [];
    let rollbackFailed = false;
    for (let i = 0; i < journal.actions.length; i++) {
      const action = journal.actions[i];
      if (action.rescueError !== void 0) {
        journal.rollbackError = `rescue unavailable for ${action.path}: ${action.rescueError}`;
        journal.state = "recovery-required";
        await this.saveJournal(journal);
        failed.push({ path: action.path, message: journal.rollbackError });
        rollbackFailed = true;
        continue;
      }
      opts?.crash?.("before-action", i);
      let reached;
      try {
        reached = await probe.matches(action.rescue, action.path) === true;
      } catch {
        reached = false;
      }
      if (reached) {
        action.done = false;
        await this.saveJournal(journal);
        continue;
      }
      let applied;
      try {
        applied = await this.applyActionToDisk(
          action.rescue === null ? "delete" : "restore",
          action.path,
          action.rescue,
          deleteFile,
          {
            ...action.rescueMode !== void 0 ? { mode: action.rescueMode } : {},
            ...action.parent !== void 0 ? { parent: action.parent } : {}
          }
        );
        if (applied === "skipped") {
          journal.rollbackError = `parent directory moved or repointed: ${action.path}`;
          journal.state = "recovery-required";
          await this.saveJournal(journal);
          failed.push({ path: action.path, message: journal.rollbackError });
          rollbackFailed = true;
          continue;
        }
        if (applied === "enoent") {
          action.done = false;
          await this.saveJournal(journal);
          continue;
        }
      } catch (error) {
        journal.rollbackError = error instanceof Error ? error.message : String(error);
        journal.state = "recovery-required";
        await this.saveJournal(journal);
        failed.push({ path: action.path, message: journal.rollbackError });
        rollbackFailed = true;
        continue;
      }
      opts?.crash?.("after-action", i);
      action.done = false;
      await this.saveJournal(journal);
      if (applied === "restored") restored.push(action.path);
      else deleted.push(action.path);
    }
    if (!rollbackFailed) {
      journal.state = "rolled-back";
      journal.finishedAt = Date.now();
      await this.saveJournal(journal);
    }
    return { restored, deleted, skipped: [], failed };
  }
  /**
   * Drop the session's oldest anchor groups beyond `keep` (default
   * {@link MAX_ANCHOR_GROUPS}), deleting their whole directories. Also
   * recycles terminal restore journals (see {@link pruneTerminalJournals}),
   * so the per-commit cap bounds BOTH the checkpoint entries and the journal
   * accumulation.
   *
   * Because dedup links reference prior entries, eviction is LINK-AWARE: before
   * deleting the oldest groups, any SURVIVING (kept-group) link whose `ref`
   * lands on a real snapshot inside a doomed group is MATERIALIZED (rewritten
   * as a real snapshot carrying the resolved content), so no kept link is left
   * dangling. Links form a linear predecessor chain, so materializing the first
   * link after each doomed real is enough — later links already point at that
   * materialized entry (or at other kept links), requiring no rewrite.
   *
   * `opts.crash` is the test-only seam: a crash fired inside a materialization
   * write (between its temp write and rename) leaves ONLY a `.tmp` — the doomed
   * real is still on disk and the kept link still resolves, so nothing dangles
   * and a later prune simply re-materializes.
   */
  async prune(sessionId, keep = this.maxAnchorGroups, opts) {
    const sessionDir = this.sessionDir(sessionId);
    let names;
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    await this.pruneTerminalJournals(sessionDir, names);
    await this.prunePendingCaptures(join(sessionDir, PENDING_DIR));
    const seqs = names.map(Number).filter((seq) => Number.isSafeInteger(seq)).sort((a, b) => a - b);
    const excess = seqs.length - keep;
    if (excess <= 0) return;
    const doomed = new Set(seqs.slice(0, excess));
    for (const seq of await this.pinnedAnchors(sessionDir, names)) doomed.delete(seq);
    if (doomed.size === 0) return;
    for (const seq of seqs.slice(excess)) {
      const files = await readdir(this.anchorDir(sessionId, seq)).catch(() => []);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const entryFile = join(this.anchorDir(sessionId, seq), file);
        let entry;
        try {
          entry = await readEntry(entryFile, seq);
        } catch {
          continue;
        }
        if (entry === void 0 || !isLinkEntry(entry)) continue;
        if (!isSafeLinkRef(entry.ref)) continue;
        const refAnchor = refAnchorOf(entry.ref);
        if (!Number.isSafeInteger(refAnchor) || !doomed.has(refAnchor)) continue;
        let source;
        try {
          source = await this.resolveBefore(sessionId, entry);
        } catch (error) {
          if (error instanceof UnknownStoreVersionError) throw error;
          continue;
        }
        const pin = entry.parent !== void 0 ? { parent: entry.parent } : {};
        let real;
        if (source === null) {
          real = {
            callId: entry.callId,
            anchorSeq: entry.anchorSeq,
            path: entry.path,
            before: null,
            size: 0,
            ...pin,
            time: entry.time
          };
        } else {
          const dest = join(dirname(entryFile), sidecarName(basename(entryFile)));
          await this.writeSidecar(dest, source);
          const st = await stat(dest);
          real = {
            callId: entry.callId,
            anchorSeq: entry.anchorSeq,
            path: entry.path,
            before: { kind: "blob", path: dest },
            size: st.size,
            ...source.kind === "lossyText" ? { lossy: true } : {},
            ...pin,
            time: entry.time
          };
        }
        await writeJsonAtomic(entryFile, entryToJson(real), () => opts?.crash?.("after-temp-write"));
      }
    }
    for (const seq of doomed) {
      await rm(this.anchorDir(sessionId, seq), { recursive: true, force: true });
    }
    this.seededSessions.delete(sessionId);
    for (const key of [...this.lastEntry.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key);
    }
  }
  /**
   * Collect staged captures that were never committed and are older than
   * {@link PENDING_MAX_AGE_MS}: a crash between `tools/execute` and
   * `tools/post-execute` can leak one, and the process that would have
   * unlinked it is gone.
   */
  async prunePendingCaptures(pendingDir) {
    let names;
    try {
      names = await readdir(pendingDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    for (const name2 of names) {
      const file = join(pendingDir, name2);
      const st = await lstat(file).catch(() => void 0);
      if (st === void 0 || !st.isFile() || st.mtimeMs >= cutoff) continue;
      await rm(file, { force: true });
    }
  }
  /**
   * Anchor groups a NON-TERMINAL journal still depends on — the groups holding
   * the sidecars its actions restore from. `prune` must not evict them while
   * the op can still be finished. Rescue copies live under `rescue/`, never in
   * an anchor group, so only `before` references matter; a group is pinned only
   * for a well-formed, safe reference (a corrupt journal pins nothing).
   */
  async pinnedAnchors(sessionDir, names) {
    const pinned = /* @__PURE__ */ new Set();
    for (const name2 of names) {
      if (!isJournalName(name2)) continue;
      let parsed;
      try {
        parsed = JSON.parse(await readFile(join(sessionDir, name2), "utf8"));
      } catch {
        continue;
      }
      if (!isRestoreJournal(parsed)) continue;
      const journal = journalFromJson(parsed, sessionDir);
      if (journal === void 0) continue;
      if (journal.state === "completed" || journal.state === "rolled-back") continue;
      for (const action of journal.actions) {
        const source = action.before;
        if (source === null || source.kind !== "blob") continue;
        const ref = relative(sessionDir, source.path);
        if (!isSafeBackupRef(ref)) continue;
        const anchor = refAnchorOf(ref);
        if (Number.isSafeInteger(anchor)) pinned.add(anchor);
      }
    }
    return pinned;
  }
  /**
   * Recycle terminal restore journals (`completed` / `rolled-back`): once an
   * op finished, its journal and its rescue bytes are dead weight that would
   * otherwise accumulate without bound (one journal per both-mode rewind).
   * Non-terminal journals (crashed ops awaiting reconcile / continue /
   * rollback) and unclassifiable (corrupt) ones are ALWAYS kept — a recovery
   * record that cannot be classified is never destroyed.
   */
  async pruneTerminalJournals(sessionDir, names) {
    for (const name2 of names) {
      if (!isJournalName(name2)) continue;
      const file = join(sessionDir, name2);
      try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        if (parsed.state === "completed" || parsed.state === "rolled-back") {
          await rm(file, { force: true });
          await rm(join(sessionDir, RESCUE_DIR, safeFileId(journalOpIdOf(name2))), { recursive: true, force: true });
        }
      } catch {
      }
    }
  }
  /** True when a path exists on disk. */
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }
  /**
   * Cross-session retention sweep: remove WHOLE session directories whose
   * newest member stamp is older than `maxAgeDays` days of idle, keeping the
   * active session (`keepActiveId`) untouched. This is the anti-growth policy
   * for finished sessions (rewind only ever reads the active session, so a
   * finished session's backups are provably dead weight).
   *
   * SAFETY:
   *  - Only whole session directories are removed (dedup refs are
   *    session-relative, so there is no cross-session dangling to materialize);
   *  - the active session is never targeted (`keepActiveId`), and everything
   *    else is protected by its own mtime — a session that is still written to
   *    keeps scrolling its newest member stamp forward, so it is never old
   *    enough to be pruned;
   *  - a non-positive `maxAgeDays` throws instead of degenerating into a
   *    mass-destructive `cutoff` in the far future;
   *  - the walk uses `lstat` (no symlink following) and skips dot-prefixed
   *    temp left overs — except the real `.pending/` area, whose staged bytes
   *    are content and whose freshness is activity — so measurement stays
   *    inside the store root.
   *
   * `dryRun` computes and reports exactly what would be removed without
   * deleting anything — the `/snapshot-auto-cleanup run` preview.
   */
  async pruneStale(opts) {
    const { keepActiveId, dryRun = false } = opts;
    const maxAgeDays = opts.maxAgeDays;
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw new RangeError("pruneStale: maxAgeDays must be a positive finite number");
    }
    const cutoffMs = Date.now() - maxAgeDays * 864e5;
    let scanned = 0;
    let deleted = 0;
    let freedBytes = 0;
    let kept = 0;
    let skippedActive = 0;
    let remainingBytes = 0;
    const report = () => ({ scanned, deleted, freedBytes, kept, remainingBytes, skippedActive, dryRun });
    let names;
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (error.code === "ENOENT") return report();
      throw error;
    }
    for (const name2 of names) {
      if (name2.startsWith(".")) continue;
      const full = join(this.root, name2);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      scanned++;
      if (keepActiveId !== void 0 && safeSessionId(keepActiveId) === name2) {
        skippedActive++;
        remainingBytes += (await dirSizeAndLastActive(full)).size;
        continue;
      }
      const { size, lastActiveMs } = await dirSizeAndLastActive(full);
      if (lastActiveMs < cutoffMs) {
        deleted++;
        freedBytes += size;
        if (!dryRun) await rm(full, { recursive: true, force: true });
      } else {
        kept++;
        remainingBytes += size;
      }
    }
    if (!dryRun) await this.forgetMissingSessions();
    return report();
  }
  /**
   * All distinct paths ever recorded for a session — the "tracked files"
   * set. Mirrors Claude Code's global `trackedFiles` collection (files stay
   * tracked once a write-class tool touched them), derived from the disk
   * entries so no extra persistence is needed.
   */
  async trackedPaths(sessionId) {
    const paths = /* @__PURE__ */ new Set();
    for (const entry of await this.entriesAfter(sessionId, 0)) {
      paths.add(entry.path);
    }
    return paths;
  }
  /**
   * The session's recorded paths whose current size is over the cap, so no
   * backup of that state exists. One `stat` per recorded path; a path first seen
   * over the cap was never recorded and is therefore not listed.
   */
  async uncoveredPaths(sessionId, probe = defaultProbe) {
    const sizeOf = probe.size?.bind(probe);
    if (this.maxFileBytes <= 0 || sizeOf === void 0) return [];
    const uncovered = [];
    for (const path of await this.trackedPaths(sessionId)) {
      const size = await sizeOf(path);
      if (this.isOverFileCap(size)) uncovered.push({ path, ...size !== void 0 ? { size } : {} });
    }
    return uncovered;
  }
  /**
   * Summarize a session's on-disk footprint for a clear dry-run: anchor-group
   * count, committed checkpoint-entry count (one per `.json` in an anchor
   * group), restore-journal count (both journal prefixes), and the total bytes
   * the session dir occupies — entry JSONs, raw byte sidecars, `rescue/**` and
   * the staged `.pending/**` copies alike, so the number matches what a `du` of
   * that directory reports.
   *
   * Walks with `lstat` (never follows a symlink, so a hostile symlink cannot
   * escape the store root or inflate the measurement) and skips dot-prefixed
   * temp leftovers (the one exception is `.pending/`, whose staged bytes are
   * real store content).
   */
  async sessionStats(sessionId) {
    const sessionDir = this.sessionDir(sessionId);
    let names;
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if (isEnoent(error)) return { anchorGroups: 0, entries: 0, journals: 0, bytes: 0 };
      throw error;
    }
    let anchorGroups = 0;
    let entries = 0;
    let journals = 0;
    let bytes = 0;
    for (const name2 of names) {
      if (name2.startsWith(".") && name2 !== PENDING_DIR) continue;
      const full = join(sessionDir, name2);
      const st = await lstat(full).catch(() => void 0);
      if (st === void 0) continue;
      if (st.isDirectory()) {
        if (name2 === PENDING_DIR || name2 === RESCUE_DIR) {
          bytes += await dirBytes(full);
          continue;
        }
        if (!Number.isSafeInteger(Number(name2))) continue;
        anchorGroups++;
        for (const file of await readdir(full).catch(() => [])) {
          if (file.endsWith(".json")) entries++;
        }
        bytes += await dirBytes(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (isJournalName(name2)) journals++;
      bytes += st.size;
    }
    return { anchorGroups, entries, journals, bytes };
  }
  /**
   * Remove a session's ENTIRE snapshot directory — every anchor group, every
   * checkpoint entry, and every restore journal — and reset the store's
   * in-memory dedup state so the session starts recording fresh from the
   * current workspace state. This is the manual "get rid of this session's
   * records NOW" action on the ACTIVE session the user is driving (it is never
   * targetable by id; that is a directory-manipulation concern the user can do
   * directly).
   *
   * SEMANTICS — clearing is an explicit abandonment: issuing the command means
   * the user accepts that this session's snapshot archive goes away. It is
   * therefore NOT gated on the state of any restore journal. A clear and a
   * restore are both slash commands the host runs to completion for an agent,
   * so they never interleave — any non-terminal journal present on disk is a
   * stale orphan from a previous (crashed) process, and discarding it is the
   * correct, safe resolution of that abandoned restore.
   *
   * SAFETY (this module's real concern is the plugin's ongoing BEHAVIOR, not
   * losing snapshots):
   *  - Only the session dir is removed; dedup refs are session-relative, so
   *    there is no cross-session dangling to materialize (the same rationale as
   *    {@link pruneStale}'s whole-dir removal).
   *  - The in-memory dedup state (`lastEntry` / `seededSessions`) is ALWAYS
   *    reset on an apply — even when the dir was already empty. A stale
   *    in-memory entry (e.g. a session whose dir was removed out-of-band) would
   *    otherwise link a later `recordEntry` to a deleted prior entry, leaving a
   *    dangling ref that breaks restore resolution. This is the primary
   *    correctness guarantee.
   *
   * `dryRun` computes the report without touching disk or memory.
   */
  async clearSession(sessionId, opts) {
    const dryRun = opts?.dryRun ?? false;
    const stats = await this.sessionStats(sessionId);
    if (!dryRun) {
      if (stats.anchorGroups > 0 || stats.journals > 0 || stats.bytes > 0) {
        await rm(this.sessionDir(sessionId), { recursive: true, force: true });
      }
      this.forgetSession(sessionId);
    }
    return { sessionId, ...stats, dryRun };
  }
  /**
   * Read the session-format version marker recorded for a session, or `null`
   * when there is no marker — a pre-marker, legacy snapshot dir, or a session
   * that never materialized a dir.
   */
  async readFormatVersion(sessionId) {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), _SnapshotStore.FORMAT_FILE), "utf8");
      const parsed = Number(raw.trim());
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  /**
   * Record the session-format version a session's snapshots are anchored under
   * (`session.header.version`: 2 for the v2 format, 3 for the v3 format). The
   * marker is a tiny non-`.json` file, so it never counts as a checkpoint
   * entry in `sessionStats`/`clearSession`. Written atomically (temp + rename)
   * like every other persisted marker, so a crash mid-write can only leave an
   * inert `format.tmp` — never a partial marker that a later reconcile could
   * misread as a version mismatch and wrongly clear.
   */
  async markFormatVersion(sessionId, sessionVersion) {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, _SnapshotStore.FORMAT_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${sessionVersion}`, "utf8");
    await rename(tmp, file);
  }
  /**
   * Set the session-format version the store stamps onto every snapshot it
   * records. The host sets this once per process from `agent/created`
   * (`agent.session.header.version`), so a marker is only materialized for a
   * session that actually records a snapshot.
   */
  setFormatVersion(sessionVersion) {
    this.formatVersion = sessionVersion;
  }
  /**
   * Read the plugin's STORE-format marker for a session, or null when there is
   * none (a released-v1 dir, or a session that never recorded a snapshot). The
   * marker is a quick session-level signal; every entry and journal is also
   * self-describing (`store` / `version`), so a missing marker never changes
   * how an entry is read.
   */
  async readStoreVersion(sessionId) {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), _SnapshotStore.STORE_FILE), "utf8");
      const parsed = Number(raw.trim());
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  /**
   * Stamp the store-format marker (atomically, like `format`). Written
   * alongside every byte-format entry, so a session that only ever holds the
   * released string format keeps no marker and is read as v1.
   */
  async markStoreVersion(sessionId, storeVersion) {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, _SnapshotStore.STORE_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${storeVersion}`, "utf8");
    await rename(tmp, file);
  }
  /**
   * Refuse to plan against (or write into) a session whose store format is
   * NEWER than this build understands (ADR-10): the caller reports it and
   * changes nothing — no partial restore, no clear, no v2 entry written into a
   * v3 store. Checked before any entry is read, so the marker alone is enough
   * to fail closed.
   */
  async assertKnownStoreVersion(sessionId) {
    const version = await this.readStoreVersion(sessionId);
    if (version !== null && version > CURRENT_STORE_VERSION) {
      throw new UnknownStoreVersionError(version, join(this.sessionDir(sessionId), _SnapshotStore.STORE_FILE));
    }
  }
  /**
   * Session-format-version guard: clear a session's snapshot dir when the
   * format its snapshots were anchored under differs from the current session
   * format, so seq-anchored references can never survive a format migration
   * mis-mapped. Runs at `agent/created` — after DSH has migrated/loaded
   * the session, so `sessionVersion` is the post-migration value.
   *
   * Conservative rule (per the "delete stale snapshots" policy): a session
   * with no recorded marker but with snapshot content is treated as legacy and
   * cleared; a session whose marker differs from `sessionVersion` is cleared.
   * A matching version — or an untouched session with nothing to protect — is
   * left alone. The marker is re-stamped to the current version afterward so a
   * FUTURE format change is detected on the next start.
   *
   * @returns whether a session snapshot dir was cleared.
   */
  async reconcileFormatVersion(sessionId, sessionVersion) {
    const stored = await this.readFormatVersion(sessionId);
    if (stored === sessionVersion) return { cleared: false };
    const stats = await this.sessionStats(sessionId);
    const hasContent = stats.anchorGroups > 0 || stats.journals > 0;
    if (hasContent) {
      await this.clearSession(sessionId);
    }
    if (hasContent || stored !== null) {
      await this.markFormatVersion(sessionId, sessionVersion);
    }
    return { cleared: hasContent };
  }
};
function hashPath(path) {
  return shortHash(path);
}
async function reconcileTracked(store, sessionId, anchorSeq, tracked, probe = defaultProbe) {
  try {
    await store.assertKnownStoreVersion(sessionId);
  } catch {
    return 0;
  }
  let recorded = 0;
  for (const path of tracked) {
    try {
      if (await probe.isLink(path)) continue;
      if (store.isOverFileCap(await probe.size?.(path))) continue;
      const last = await store.lastKnownContent(sessionId, path);
      if (last !== void 0 && last !== null && last.kind !== "lossyText") {
        const same = await probe.matches(last, path);
        if (same === void 0 || same) continue;
      }
      const callId = `recheck-${anchorSeq}-${hashPath(path)}`;
      const staged = await store.stageCapture(sessionId, callId);
      const copied = await probe.copy(path, staged);
      if (copied.kind === "failed") {
        await rm(staged, { force: true });
        continue;
      }
      await store.recordBackup(
        sessionId,
        { callId, anchorSeq, path },
        copied.kind === "absent" ? null : { file: staged, size: copied.size },
        { dedup: false }
      );
      recorded++;
    } catch {
    }
  }
  return recorded;
}

// src/snapshot-cleanup.ts
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
import { resolveDshHome as resolveDshHome2 } from "@deepseek-ai/dsh-home-paths";
var DEFAULT_MAX_AGE_DAYS = 30;
var DEFAULT_CLEANUP_CONFIG = { enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS };
function volatileCleanupStore(settings, writer) {
  return {
    load: () => ({
      enabled: settings.autoCleanupEnabled.get() ?? DEFAULT_CLEANUP_CONFIG.enabled,
      maxAgeDays: settings.autoCleanupMaxAgeDays.get() ?? DEFAULT_CLEANUP_CONFIG.maxAgeDays
    }),
    save: async (next) => {
      const parsed = parseCleanupConfig({ enabled: next.enabled, maxAgeDays: next.maxAgeDays });
      if (!parsed.ok) throw new RangeError(parsed.error);
      const clear = [];
      const patch = {};
      if (parsed.config.enabled === DEFAULT_CLEANUP_CONFIG.enabled) clear.push("autoCleanupEnabled");
      else patch.autoCleanupEnabled = parsed.config.enabled;
      if (parsed.config.maxAgeDays === DEFAULT_CLEANUP_CONFIG.maxAgeDays) clear.push("autoCleanupMaxAgeDays");
      else patch.autoCleanupMaxAgeDays = parsed.config.maxAgeDays;
      if (clear.length > 0) await writer.clear(writer.entryId, clear);
      if (Object.keys(patch).length > 0) await writer.update(writer.entryId, patch);
    }
  };
}
var AUTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var STATE_FILENAME = "snapshot-cleanup-last-sweep.json";
function resolveCleanupStatePath(dshHome) {
  return join2(resolveDshHome2(dshHome), STATE_FILENAME);
}
async function loadLastSweepAt(path) {
  try {
    const raw = JSON.parse(await readFile2(path, "utf8"));
    const value = raw["lastSweepAt"];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
async function saveLastSweepAt(path, ms) {
  const tmp = `${path}.tmp`;
  await mkdir2(dirname2(path), { recursive: true });
  await writeFile2(tmp, JSON.stringify({ lastSweepAt: ms }), "utf8");
  await rename2(tmp, path);
}
function isAborted(signal) {
  return signal?.aborted === true;
}
async function runAutoCleanupCheck(deps, sessionId) {
  try {
    const loaded = await deps.readConfig();
    if (!loaded.ok) {
      deps.log(`[dsh-rewind] snapshot cleanup config invalid; auto-cleanup skipped: ${loaded.error}`);
      return;
    }
    if (!loaded.config.enabled) return;
    if (isAborted(deps.signal)) return;
    if (!shouldRunAutoSweep(await loadLastSweepAt(deps.statePath), Date.now(), deps.intervalMs)) return;
    if (isAborted(deps.signal)) return;
    await deps.pruner.pruneStale({ keepActiveId: sessionId, maxAgeDays: loaded.config.maxAgeDays });
    if (isAborted(deps.signal)) return;
    await saveLastSweepAt(deps.statePath, Date.now());
  } catch (error) {
    deps.log(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function parseCleanupConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be a JSON object" };
  }
  const record = raw;
  let enabled = DEFAULT_CLEANUP_CONFIG.enabled;
  let maxAgeDays = DEFAULT_CLEANUP_CONFIG.maxAgeDays;
  if (record["enabled"] !== void 0) {
    if (typeof record["enabled"] !== "boolean") return { ok: false, error: '"enabled" must be a boolean' };
    enabled = record["enabled"];
  }
  if (record["maxAgeDays"] !== void 0) {
    const value = record["maxAgeDays"];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return { ok: false, error: '"maxAgeDays" must be a positive integer' };
    }
    maxAgeDays = value;
  }
  return { ok: true, config: { enabled, maxAgeDays } };
}
function parseCleanupCommand(rawInput) {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "status" };
  switch (parts[0]) {
    case "status":
      return parts.length === 1 ? { action: "status" } : { error: "usage: /snapshot-auto-cleanup status" };
    case "on":
      return parts.length === 1 ? { action: "on" } : { error: "usage: /snapshot-auto-cleanup on" };
    case "off":
      return parts.length === 1 ? { action: "off" } : { error: "usage: /snapshot-auto-cleanup off" };
    case "max-age": {
      if (parts.length !== 2) return { error: "usage: /snapshot-auto-cleanup max-age <days>" };
      const days = Number(parts[1]);
      if (!Number.isInteger(days) || days <= 0) return { error: '"max-age" must be a positive integer (days)' };
      return { action: "max-age", value: days };
    }
    case "run-apply":
      return { error: 'the "run-apply" abbreviation was removed; use "run --apply"' };
    case "run": {
      let apply2 = false;
      let current = false;
      for (const rawFlag of parts.slice(1)) {
        if (rawFlag === "--apply") {
          apply2 = true;
        } else if (rawFlag === "--current") {
          current = true;
        } else {
          return { error: `unknown /snapshot-auto-cleanup run flag "${rawFlag}"` };
        }
      }
      return { action: "run", target: current ? "current" : "rules", apply: apply2 };
    }
    default:
      return { error: `unknown /snapshot-auto-cleanup subcommand "${parts[0]}"` };
  }
}
function shouldRunAutoSweep(lastAtMs, nowMs, intervalMs = AUTO_SWEEP_INTERVAL_MS) {
  return nowMs - lastAtMs >= intervalMs;
}

// src/index.ts
var name = "dsh-rewind";
var inject = ["commands", "tools", "settings"];
var ENGINE_COMMAND = "rewind-plugin";
var REWIND_RPC_CHANNEL = "/dsh-rewind";
var DEFAULT_FILE_CHECKPOINTING_ENABLED = true;
var Config = z.object({
  snapshotDir: z.string().required(false),
  dshHome: z.string().required(false),
  dedup: z.boolean().default(true),
  maxFileBytes: z.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES),
  maxAnchorGroups: z.number().step(1).min(1).default(MAX_ANCHOR_GROUPS),
  autoSweepIntervalMs: z.number().step(1).min(1).default(AUTO_SWEEP_INTERVAL_MS),
  fileCheckpointingEnabled: z.boolean().default(DEFAULT_FILE_CHECKPOINTING_ENABLED).volatile(),
  autoCleanupEnabled: z.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled).volatile(),
  autoCleanupMaxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile(),
  // [dsh-artifact-patch] 命令产物追踪（渲染/ffmpeg 等非 write/edit 产物）
  artifactTrackingEnabled: z.boolean().default(true),
  artifactMaxFileBytes: z.number().step(1).min(0).default(64 * 1024 * 1024),
  artifactBaselineContent: z.boolean().default(false),
  artifactExclude: z.string().default("node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target"),
  artifactKeepManifests: z.number().step(1).min(1).default(20)
});
function isFileCheckpointingEnabled(config) {
  return config?.fileCheckpointingEnabled?.get() !== false;
}
var TRACKED_TOOLS = /* @__PURE__ */ new Set(["write", "edit"]);
function isSubagentSession(session) {
  const header = session.header;
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}
var activeLocale = "en";
var LOCALE_ENTRY = "locale";
var LOCALE_FIELD = "preference";
function readHostLocale(ctx) {
  try {
    const row = ctx.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === LOCALE_ENTRY);
    return preferredLocale(row?.value?.[LOCALE_FIELD]);
  } catch {
    return "en";
  }
}
var cleanupStore;
var artifactTracker;
function t(key, params) {
  return translate(activeLocale, key, params);
}
function warnCommandUnavailable(ctx, name2, error) {
  ctx.logger.warn(`[dsh-rewind] command "${name2}" was not registered: ${error instanceof Error ? error.message : String(error)}`);
  if (name2 === ENGINE_COMMAND) {
    ctx.logger.warn(`[dsh-rewind] the internal "${ENGINE_COMMAND}" engine channel is unavailable; rewind execution will not work.`);
  }
}
async function discardCapture(capture) {
  if (capture === void 0 || capture.backup === null) return;
  try {
    await rm2(capture.backup.file, { force: true });
  } catch {
  }
}
function mutationPathOf(exec) {
  const args = exec.arguments;
  if (exec.name === "write" || exec.name === "edit") {
    return typeof args.file_path === "string" ? args.file_path : void 0;
  }
  return void 0;
}
function anchorSeqOf(session, cache) {
  const events = session.snapshotEvents();
  const cached = cache.get(session);
  if (cached !== void 0 && cached.eventsLength === events.length) return cached.anchor;
  let anchor = cached?.anchor;
  for (let i = events.length - 1; i >= (cached?.eventsLength ?? 0); i--) {
    if (events[i].type === "user/message") {
      anchor = events[i].seq;
      break;
    }
  }
  cache.set(session, { anchor, eventsLength: events.length });
  return anchor;
}
async function resolveTarget(fs, path, cwd, signal) {
  try {
    return await fs.resolve(path, { cwd, signal });
  } catch {
    return void 0;
  }
}
function isNotFoundError(error) {
  const code = error?.code;
  return code === "ENOENT" || code === "FS_NOT_FOUND";
}
async function captureBefore(fs, workingDirectory, store, exec, pending) {
  if (!TRACKED_TOOLS.has(exec.name)) return;
  const agent = exec.agent;
  if (agent === void 0) return;
  if (isSubagentSession(agent.session)) return;
  const path = mutationPathOf(exec);
  if (path === void 0) return;
  const cwd = await workingDirectory.ensure(agent, exec.signal);
  const target = await resolveTarget(fs, path, cwd, exec.signal);
  if (target === void 0) return;
  const info = await fs.stat(target, exec.signal).catch((error) => {
    if (isNotFoundError(error)) return void 0;
    throw error;
  });
  if (info !== void 0 && info.type !== "file") return;
  if (info !== void 0 && store.isOverFileCap(info.size)) return;
  const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
  if (info === void 0) {
    pending.set(key, { path: target.displayPath, backup: null });
    return;
  }
  const staged = await store.stageCapture(agent.session.id, key);
  let backup;
  try {
    await copyFile2(target.displayPath, staged);
    const st = await stat2(staged);
    const source = await stat2(target.displayPath).catch(() => void 0);
    backup = {
      file: staged,
      size: st.size,
      ...source !== void 0 ? { mode: source.mode & 4095 } : {}
    };
  } catch (error) {
    await rm2(staged, { force: true });
    throw error;
  }
  pending.set(key, { path: target.displayPath, backup });
}
async function commitEntry(store, pending, anchorCache, trackedBySession, exec, result, checkpointingEnabled) {
  const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
  const capture = pending.get(key);
  if (capture === void 0) return;
  pending.delete(key);
  if (!checkpointingEnabled) {
    await discardCapture(capture);
    return;
  }
  if (result.isError) {
    await discardCapture(capture);
    return;
  }
  const agent = exec.agent;
  if (agent === void 0) {
    await discardCapture(capture);
    return;
  }
  const anchorSeq = anchorSeqOf(agent.session, anchorCache);
  if (anchorSeq === void 0) {
    await discardCapture(capture);
    return;
  }
  try {
    await store.recordBackup(agent.session.id, {
      callId: exec.callId,
      anchorSeq,
      path: capture.path
    }, capture.backup);
  } catch (error) {
    await discardCapture(capture);
    throw error;
  }
  let tracked = trackedBySession.get(agent.session.id);
  if (tracked === void 0) {
    tracked = /* @__PURE__ */ new Set();
    trackedBySession.set(agent.session.id, tracked);
  }
  tracked.add(capture.path);
}
var REWIND_MARKER_CONTENT = [{ type: "text", text: "(empty message)" }];
function buildMarker() {
  return createUserMessage({
    content: REWIND_MARKER_CONTENT,
    source: REWIND_MARKER_SOURCE
  });
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
function resolveOrError(events, surface, raw) {
  const target = parseRewindTarget(raw);
  if (target === void 0) {
    throw new RewindError("invalid-index", t("error.invalidTarget", { raw }));
  }
  return planRewind(events, surface, target);
}
async function previewImpact(store, session, seq, checkpointingEnabled) {
  const plan = resolveOrError(session.snapshotEvents(), session.surface.nodes, `@${seq}`);
  let impacts;
  try {
    impacts = await store.impactsAfter(session.id, plan.targetSeq);
  } catch (error) {
    if (!(error instanceof UnknownStoreVersionError)) throw error;
    throw new Error(t("storeUnsupported", { version: await store.readStoreVersion(session.id) ?? 0 }));
  }
  const uncovered = await store.uncoveredPaths(session.id).catch(() => []);
  let artifactImpacts = [];
  if (artifactTracker !== void 0) {
    try {
      artifactImpacts = await artifactTracker.preview(session.id, plan.targetSeq);
    } catch (error) {
      artifactImpacts = [];
    }
  }
  const known = new Set(impacts.map((item) => item.path));
  const mergedImpacts = impacts.concat(artifactImpacts.filter((item) => !known.has(item.path)));
  mergedImpacts.sort((a, b) => a.path.localeCompare(b.path));
  return { files: mergedImpacts, uncovered, backupOff: !checkpointingEnabled };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rpcFailure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
function createRewindRpcHandler(store, agentsOf, checkpointingEnabled) {
  return async (endpoint, payload) => {
    try {
      if (!isRecord(payload)) return rpcFailure("rewind/bad-request", "invalid payload");
      const sessionId = payload["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return rpcFailure("rewind/bad-request", "sessionId must be a non-empty string");
      }
      const agents = agentsOf();
      if (agents === void 0) return rpcFailure("rewind/agents-unavailable", "agent registry is unavailable");
      const agent = agents.get(sessionId);
      if (agent === void 0) return rpcFailure("rewind/session-not-found", `session ${sessionId} is not attached`);
      const session = agent.session;
      if (endpoint === "preview") {
        const seq = payload["seq"];
        if (!Number.isSafeInteger(seq)) return rpcFailure("rewind/bad-request", "seq must be an integer");
        return { ok: true, value: await previewImpact(store, session, seq, checkpointingEnabled()) };
      }
      if (endpoint === "candidates") {
        return {
          ok: true,
          value: { candidates: listRewindCandidates(session.snapshotEvents(), session.surface.nodes) }
        };
      }
      return rpcFailure("rewind/unknown-endpoint", `unknown endpoint: ${endpoint}`);
    } catch (error) {
      return rpcFailure("rewind/failed", error instanceof Error ? error.message : String(error));
    }
  };
}
function renderFailures(failed) {
  if (failed.length === 0) return "";
  return t("failures.suffix", {
    count: failed.length,
    list: failed.map((f) => t("failures.item", { path: f.path, message: f.message })).join(t("sep.list"))
  });
}
function renderSkipped(outcome, uncovered, maxFileBytes) {
  const capped = new Set(uncovered.map((item) => item.path));
  const limit = formatBytes(maxFileBytes);
  return outcome.skipped.filter((path) => capped.has(path)).map((path) => t("plan.skip", { path, reason: t("skipReason.oversized", { limit }) })).join("\n");
}
async function resolveObservationTarget(fs, path) {
  try {
    return await fs.resolve(path);
  } catch {
    return void 0;
  }
}
async function syncRestoreObservations(ctx, fs, agent, outcome) {
  if (fs === void 0) return;
  const actor = { agent };
  for (const path of outcome.deleted) {
    const target = await resolveObservationTarget(fs, path);
    if (target === void 0) continue;
    ctx.emit("fs/observed", target, { kind: "absent" }, actor);
  }
  for (const path of outcome.restored) {
    const target = await resolveObservationTarget(fs, path);
    if (target === void 0) continue;
    const info = await fs.stat(target).catch(() => void 0);
    if (info === void 0) continue;
    ctx.emit("fs/observed", target, { kind: "present", version: info.version }, actor);
  }
}
async function waitForAgentIdle(agent, signal, timeoutMs = 15e3) {
  if (signal.aborted) return false;
  let timer;
  let onAbort;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("rewind idle wait timed out")), timeoutMs);
        onAbort = () => reject(new Error("rewind idle wait aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
  }
}
function dropPendingSteering(agent) {
  for (const message of [...agent.inbox.nextStep]) {
    agent.inbox.remove(message.id);
  }
}
async function executeRewind(ctx, store, fs, invocation, rawTarget, mode, inflight, checkpointingEnabled) {
  const { agent } = invocation;
  const sessionId = agent.session.id;
  if (inflight.has(sessionId)) {
    return { kind: "error", text: t("inflight") };
  }
  inflight.add(sessionId);
  try {
    if (agent.status !== "idle") {
      agent.cancel({ kind: "user" }, { keepInbox: true });
      const stopped = await waitForAgentIdle(agent, invocation.signal);
      if (!stopped) {
        return { kind: "error", text: t("stopFailed") };
      }
    }
    dropPendingSteering(agent);
    if (invocation.signal.aborted) {
      return { kind: "error", text: t("cancelled") };
    }
    let plan;
    try {
      plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget);
    } catch (error) {
      return rewindErrorResult(error);
    }
    const marker = buildMarker();
    let event;
    try {
      event = agent.session.append("user/message", marker, {
        surfaceOp: { op: "replace", startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs]
      });
    } catch (error) {
      return {
        kind: "error",
        text: t("failed", { error: error instanceof Error ? error.message : String(error) })
      };
    }
    let restore = "";
    if (mode === "both") {
      let outcome;
      try {
        outcome = await store.restoreAfter(agent.session.id, plan.targetSeq, (path) => unlink(path));
      } catch (error) {
        if (!(error instanceof UnknownStoreVersionError)) throw error;
        const version = await store.readStoreVersion(agent.session.id);
        restore = `${t("sep.clause")}${t("storeUnsupported", { version: version ?? error.version })}`;
      }
      if (outcome !== void 0) {
        await syncRestoreObservations(ctx, fs, agent, outcome);
        const parts = [];
        if (outcome.restored.length > 0) parts.push(t("restore.count", { count: outcome.restored.length }));
        if (outcome.deleted.length > 0) parts.push(t("delete.count", { count: outcome.deleted.length }));
        if (outcome.skipped.length > 0) {
          parts.push(t("skip.count", { count: outcome.skipped.length }));
          const capped = await store.uncoveredPaths(agent.session.id).catch(() => []);
          const skippedLines = renderSkipped(outcome, capped, store.fileCapBytes);
          if (skippedLines !== "") parts.push(skippedLines);
        }
        if (!checkpointingEnabled) parts.push(t("backupOff"));
        restore = parts.length > 0 ? `${t("sep.clause")}${parts.join(t("sep.list"))}` : t("noRestorable");
        restore += renderFailures(outcome.failed);
      }
    }
    if (mode === "both" && artifactTracker !== void 0) {
      try {
        const q = await artifactTracker.restore(agent.session.id, plan.targetSeq, event.seq);
        if (fs !== void 0 && (q.restoredPaths.length > 0 || q.quarantinedPaths.length > 0)) {
          await syncRestoreObservations(ctx, fs, agent, { restored: q.restoredPaths, deleted: q.quarantinedPaths });
        }
        const bits = [];
        if (q.restored > 0) bits.push(t("restore.count", { count: q.restored }));
        if (q.quarantine > 0) bits.push(t("artifact.moved", { count: q.quarantine, dir: q.dir ?? "" }));
        if (q.skipped > 0) bits.push(t("artifact.unbacked", { count: q.skipped }));
        if (q.failed > 0) bits.push(t("artifact.failed", { count: q.failed }));
        if (bits.length > 0) {
          const line = `${t("artifact.prefix")}${bits.join(t("sep.list"))}`;
          restore = restore === "" ? line : `${restore}${t("sep.clause")}${line}`;
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] artifact restore failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      kind: "success",
      text: t("success", { targetSeq: plan.targetSeq, restore }),
      sourceEventSeq: event.seq
    };
  } finally {
    inflight.delete(sessionId);
  }
}
function rewindErrorResult(error) {
  if (error instanceof RewindError) {
    const text = {
      "no-user-messages": t("noUserMessages"),
      "invalid-index": error.message,
      "not-a-user-message": error.message,
      "not-on-surface": error.message
    }[error.code];
    return { kind: "error", text };
  }
  throw error;
}
async function handleRewind(ctx, store, fs, invocation, inflight, checkpointingEnabled) {
  const session = invocation.agent.session;
  const input = invocation.rawInput.trim();
  if (input === "") {
    const candidates = listRewindCandidates(session.snapshotEvents(), session.surface.nodes, 1);
    if (candidates.length === 0) {
      return { kind: "error", text: t("noUserMessages") };
    }
    return executeRewind(ctx, store, fs, invocation, `@${candidates[0].seq}`, "chat", inflight, checkpointingEnabled);
  }
  const parts = input.split(/\s+/);
  const target = parts[0];
  const mode = parts[1];
  if (mode !== void 0 && mode !== "chat" && mode !== "both") {
    return { kind: "error", text: t("engine.rejected") };
  }
  if (mode === void 0) return { kind: "error", text: t("engine.rejected") };
  return executeRewind(ctx, store, fs, invocation, target, mode, inflight, checkpointingEnabled);
}
var autoSweepChecked = false;
async function maybeRunAutoCleanup(ctx, store, sessionId, dshHome, sweepIntervalMs, signal) {
  if (autoSweepChecked || signal?.aborted === true) return;
  autoSweepChecked = true;
  try {
    await runAutoCleanupCheck({
      pruner: store,
      readConfig: () => readCleanupPolicy(),
      statePath: resolveCleanupStatePath(dshHome),
      log: (msg) => ctx.logger.warn(msg),
      ...sweepIntervalMs === void 0 ? {} : { intervalMs: sweepIntervalMs },
      ...signal === void 0 ? {} : { signal }
    }, sessionId);
  } catch (error) {
    try {
      ctx.logger.warn(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
    }
  }
}
async function readCleanupPolicy() {
  if (cleanupStore === void 0) {
    return { ok: false, error: "cleanup policy unavailable; snapshot cleanup policy cannot be read" };
  }
  return { ok: true, config: cleanupStore.load() };
}
async function writeCleanupPolicy(next) {
  if (cleanupStore === void 0) throw new Error("cleanup policy unavailable; snapshot cleanup policy cannot be written");
  await cleanupStore.save(next);
}
function formatCleanupReport(report) {
  const key = report.dryRun ? "cleanup.runDry" : "cleanup.runApply";
  const text = t(key, {
    deleted: report.deleted,
    freed: report.freedBytes,
    kept: report.kept,
    remaining: report.remainingBytes
  });
  return report.skippedActive > 0 ? `${text}
${t("cleanup.skipped", { skipped: report.skippedActive })}` : text;
}
async function handleSnapshotCleanup(store, invocation, dshHome, trackedBySession) {
  const parsed = parseCleanupCommand(invocation.rawInput);
  if ("error" in parsed) return { kind: "error", text: t("cleanup.usage") };
  switch (parsed.action) {
    case "status": {
      const loaded = await readCleanupPolicy();
      if (!loaded.ok) return { kind: "error", text: t("cleanup.cfgInvalid", { detail: loaded.error }) };
      return {
        kind: "success",
        text: t("cleanup.status", {
          state: t(loaded.config.enabled ? "cleanup.enabled" : "cleanup.disabled"),
          days: loaded.config.maxAgeDays
        })
      };
    }
    case "on":
    case "off": {
      const loaded = await readCleanupPolicy();
      const next = { ...loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG, enabled: parsed.action === "on" };
      try {
        await writeCleanupPolicy(next);
      } catch (error) {
        return { kind: "error", text: t("cleanup.saveFailed", { detail: error instanceof Error ? error.message : String(error) }) };
      }
      return { kind: "success", text: t(parsed.action === "on" ? "cleanup.onOk" : "cleanup.offOk") };
    }
    case "max-age": {
      const loaded = await readCleanupPolicy();
      const next = { ...loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG, maxAgeDays: parsed.value };
      try {
        await writeCleanupPolicy(next);
      } catch (error) {
        return { kind: "error", text: t("cleanup.saveFailed", { detail: error instanceof Error ? error.message : String(error) }) };
      }
      return { kind: "success", text: t("cleanup.maxAgeOk", { days: parsed.value }) };
    }
    case "run": {
      const apply2 = parsed.apply;
      if (parsed.target === "current") {
        return handleClearCurrent(store, invocation, apply2, trackedBySession);
      }
      const loaded = await readCleanupPolicy();
      if (!loaded.ok) return { kind: "error", text: t("cleanup.cfgInvalid", { detail: loaded.error }) };
      try {
        const report = await store.pruneStale({
          keepActiveId: invocation.agent.session.id,
          maxAgeDays: loaded.config.maxAgeDays,
          dryRun: !apply2
        });
        if (!report.dryRun) await saveLastSweepAt(resolveCleanupStatePath(dshHome), Date.now());
        return { kind: "success", text: formatCleanupReport(report) };
      } catch (error) {
        return { kind: "error", text: t("cleanup.runFailed", { detail: error instanceof Error ? error.message : String(error) }) };
      }
    }
  }
}
function formatClearReport(report) {
  const key = report.dryRun ? "cleanup.clearDry" : "cleanup.clearApply";
  return t(key, {
    entries: report.entries,
    bytes: report.bytes
  });
}
async function handleClearCurrent(store, invocation, apply2, trackedBySession) {
  const { agent } = invocation;
  const sessionId = agent.session.id;
  if (apply2) {
    if (agent.status !== "idle") {
      agent.cancel({ kind: "user" }, { keepInbox: true });
      const stopped = await waitForAgentIdle(agent, invocation.signal);
      if (!stopped) {
        return { kind: "error", text: t("cleanup.clearActive", { sessionId }) };
      }
    }
    if (invocation.signal.aborted) {
      return { kind: "error", text: t("cleanup.clearCancelled") };
    }
  }
  try {
    const report = await store.clearSession(sessionId, { dryRun: !apply2 });
    if (!report.dryRun) trackedBySession.delete(sessionId);
    return { kind: "success", text: formatClearReport(report) };
  } catch (error) {
    return { kind: "error", text: t("cleanup.clearFailed", { detail: error instanceof Error ? error.message : String(error), sessionId }) };
  }
}
var INCLUDE_ENTRY_PREFIX = "include:";
function rewindConfigKey(ctx) {
  return ctx.fiber?.entry?.id;
}
function profileEntryKey(entryId) {
  if (entryId === void 0) return void 0;
  return entryId.startsWith(INCLUDE_ENTRY_PREFIX) ? entryId.slice(INCLUDE_ENTRY_PREFIX.length) : entryId;
}
function apply(ctx, config) {
  activeLocale = readHostLocale(ctx);
  cleanupStore = void 0;
  autoSweepChecked = false;
  const lifecycle = new AbortController();
  ctx.effect(() => () => {
    lifecycle.abort();
  }, "dsh-rewind lifecycle abort");
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), "dsh-rewind page policy");
  });
  const dshHome = config?.dshHome;
  const store = new SnapshotStore(config?.snapshotDir, {
    dedup: config?.dedup,
    dshHome,
    maxFileBytes: config?.maxFileBytes,
    maxAnchorGroups: config?.maxAnchorGroups
  });
  const configKey = profileEntryKey(rewindConfigKey(ctx));
  if (config !== void 0 && configKey !== void 0) {
    const writer = {
      entryId: configKey,
      update: (id, patch) => ctx.settings.update(id, patch),
      clear: (id, fields) => ctx.settings.mutate(id, fields.map((field) => ({ op: "unset", path: [field] })))
    };
    cleanupStore = volatileCleanupStore(config, writer);
  }
  const pending = /* @__PURE__ */ new Map();
  ctx.effect(() => () => {
    const captures = [...pending.values()];
    pending.clear();
    return Promise.all(captures.map((capture) => discardCapture(capture))).then(() => void 0);
  }, "dsh-rewind dispose pending captures");
  const anchorCache = /* @__PURE__ */ new WeakMap();
  const inflight = /* @__PURE__ */ new Set();
  const trackedBySession = /* @__PURE__ */ new Map();
  const artifactCwds = /* @__PURE__ */ new Map();
  artifactTracker = config?.artifactTrackingEnabled === false
    ? void 0
    : new ArtifactTracker({
        rootDir: () => store.root,
        cwdOf: (sessionId) => artifactCwds.get(sessionId),
        maxFileBytes: config?.artifactMaxFileBytes,
        baselineContent: config?.artifactBaselineContent === true,
        exclude: config?.artifactExclude,
        keepManifests: config?.artifactKeepManifests,
        logger: ctx.logger
      });
  let fsService;
  ctx.effect(function* () {
    const withHostLocale = (handler) => (invocation) => {
      activeLocale = readHostLocale(ctx);
      return handler(invocation);
    };
    
  /**
   * Regenerate from an earlier user message (v0.19.1-any.4).
   *
   * Semantics: rewind to just before the turn triggered by the *previous* user
   * message, snapshot/quarantine the artifacts of the doomed turn, then re-send
   * the original prompt through agent.followup so the model produces a fresh
   * answer and re-runs its commands. The log stays append-only: the shadowed
   * round remains in the log behind a replace marker and is recoverable.
   */
  async function executeRegenerate(ctx, store, fs, invocation, rawTarget, mode, inflight, checkpointingEnabled) {
    const { agent } = invocation;
    const sessionId = agent.session.id;
    if (inflight.has(sessionId)) {
      return { kind: "error", text: t("regen.inflight") };
    }
    inflight.add(sessionId);
    try {
      if (typeof agent.followup !== "function") {
        return { kind: "error", text: t("regen.unsupported") };
      }
      if (agent.status !== "idle") {
        agent.cancel({ kind: "user" }, { keepInbox: true });
        const stopped = await waitForAgentIdle(agent, invocation.signal);
        if (!stopped) {
          return { kind: "error", text: t("regen.stopFailed") };
        }
      }
      if (invocation.signal.aborted) {
        return { kind: "error", text: t("regen.cancelled") };
      }
      let plan;
      try {
        plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget);
      } catch (error) {
        return rewindErrorResult(error);
      }
      // The prompt to re-send: the user message that starts the turn being
      // redone. With rewind semantics, targetSeq is the user message to rewind
      // TO (state before it); regenerating "that turn" means re-sending the
      // prompt at targetSeq itself and shadowing everything after it.
      const events = agent.session.snapshotEvents();
      const targetEvent = events.find((e2) => e2.seq === plan.targetSeq);
      const promptText = targetEvent !== void 0 ? extractUserText(targetEvent) : "";
      if (typeof promptText !== "string" || promptText.trim() === "") {
        return { kind: "error", text: t("regen.noPrompt", { seq: plan.targetSeq }) };
      }
      // Snapshot the artifacts of the doomed turn BEFORE rewinding, so the
      // current worktree state is recoverable after the model redoes its work.
      let artifactNote = "";
      if (mode === "both" && artifactTracker !== void 0) {
        try {
          const snap = await artifactTracker.recordSnapshotForRegenerate(sessionId, plan.targetSeq);
          if (snap !== "") artifactNote = snap;
        } catch (error) {
          ctx.logger.warn("[dsh-any-rollback] artifact pre-snapshot failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
      const marker = buildMarker();
      let event;
      try {
        event = agent.session.append("user/message", marker, {
          surfaceOp: { op: "replace", startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
          sourceEventSeqs: [...plan.shadowedSeqs]
        });
      } catch (error) {
        return { kind: "error", text: t("regen.failed", { error: error instanceof Error ? error.message : String(error) }) };
      }
      let restore = "";
      if (mode === "both") {
        try {
          const outcome = await store.restoreAfter(sessionId, plan.targetSeq, (path) => unlink(path));
          if (outcome !== void 0) {
            await syncRestoreObservations(ctx, fs, agent, outcome);
            const parts = [];
            if (outcome.restored.length > 0) parts.push(t("restore.count", { count: outcome.restored.length }));
            if (outcome.deleted.length > 0) parts.push(t("delete.count", { count: outcome.deleted.length }));
            restore = parts.length > 0 ? t("sep.clause") + parts.join(t("sep.list")) : "";
          }
        } catch (error) {
          if (!(error instanceof UnknownStoreVersionError)) throw error;
        }
      }
      if (mode === "both" && artifactTracker !== void 0) {
        try {
          const q = await artifactTracker.restore(sessionId, plan.targetSeq, event.seq);
          if (fs !== void 0 && (q.restoredPaths.length > 0 || q.quarantinedPaths.length > 0)) {
            await syncRestoreObservations(ctx, fs, agent, { restored: q.restoredPaths, deleted: q.quarantinedPaths });
          }
          const bits = [];
          if (q.restored > 0) bits.push(t("restore.count", { count: q.restored }));
          if (q.quarantine > 0) bits.push(t("artifact.moved", { count: q.quarantine, dir: q.dir ?? "" }));
          if (q.skipped > 0) bits.push(t("artifact.unbacked", { count: q.skipped }));
          if (bits.length > 0) {
            const line = t("artifact.prefix") + bits.join(t("sep.list"));
            restore = restore === "" ? line : restore + t("sep.clause") + line;
          }
        } catch (error) {
          ctx.logger.warn("[dsh-any-rollback] artifact restore failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
      // Re-send the original prompt. followup queues a user turn on the live
      // agent; the model answers fresh and re-runs its commands.
      const message = {
        id: "regen-" + event.seq + "-" + Date.now().toString(36),
        role: "user",
        content: [{ type: "text", text: promptText }],
        source: { kind: "user", rpcId: "dsh-any-rollback" }
      };
      agent.followup(message);
      const text2 = t("regen.success", {
        targetSeq: plan.targetSeq,
        restore: restore === "" ? (artifactNote === "" ? "" : artifactNote) : restore + (artifactNote === "" ? "" : t("sep.clause") + artifactNote)
      });
      return {
        kind: "success",
        text: text2 + t("regen.resendNote"),
        sourceEventSeq: event.seq
      };
    } finally {
      inflight.delete(sessionId);
    }
  }

  /**
   * Derive the regenerate/version history from the session log (stage 2).
   *
   * Every regenerate appends a replace marker whose content is the rewind
   * placeholder; we tag ours with data.op = "regenerate" so the pages are
   * recoverable without any extra storage. Version pages for one prompt =
   * [original turn] + one entry per regenerate marker that shadows from the
   * same targetSeq.
   * @returns {{ pages: Array<{ index: number, markerSeq: number, targetSeq: number, at: number, active: boolean }>, targetSeq: number }}
   */
  function regenVersionsOf(events, targetSeq) {
    const pages = [];
    // original = the user message at targetSeq itself
    let active = true; // the original turn is active until a marker shadows it
    for (const event of events) {
      if (event.type !== "user/message") continue;
      const op = event.data?.op;
      const cited = Array.isArray(event.data?.sourceEventSeqs) ? event.data.sourceEventSeqs : [];
      if (op !== "regenerate" || !cited.includes(targetSeq)) continue;
      pages.push({ index: pages.length + 1, markerSeq: event.seq, targetSeq, at: event.time ?? 0, active: false });
    }
    // The active page is the LAST page whose shadow interval is not itself
    // shadowed by a later marker. Walk from the end: the newest marker wins.
    for (let i = pages.length - 1; i >= 0; i--) {
      const newer = pages.slice(i + 1);
      const shadowed = newer.some((p2) => p2.markerSeq > pages[i].markerSeq && p2.targetSeq === targetSeq);
      pages[i].active = !shadowed && i === pages.length - 1;
      if (pages[i].active) break;
    }
    if (pages.length > 0) {
      const last = pages[pages.length - 1];
      // The newest page is the live one unless the surface was cut past it.
      pages.forEach((p) => { p.active = false });
      last.active = true;
    }
    return { pages, targetSeq };
  }


  /**
   * Switch a regenerate history to a chosen version page (stage 3).
   * Mechanism: append a new replace marker covering [targetSeq .. endOfSurface]
   * plus re-citing the chosen page's interval, so the surface shows exactly one
   * version. Artifacts are aligned via the artifact tracker: the current state
   * is snapshotted, then restored toward the chosen page's boundary.
   */
  async function executeRegenSwitch(ctx, store, fs, invocation, targetSeq, page, mode, inflight, checkpointingEnabled) {
    const { agent } = invocation;
    const sessionId = agent.session.id;
    if (inflight.has(sessionId)) {
      return { kind: "error", text: t("regen.inflight") };
    }
    inflight.add(sessionId);
    try {
      if (agent.status !== "idle") {
        agent.cancel({ kind: "user" }, { keepInbox: true });
        const stopped = await waitForAgentIdle(agent, invocation.signal);
        if (!stopped) return { kind: "error", text: t("regen.stopFailed") };
      }
      const events = agent.session.snapshotEvents();
      // surface end = the seq of the last surface node (the shadowed tail)
      const plan = resolveOrError(events, agent.session.surface.nodes, "@" + String(targetSeq));
      const marker = buildMarker();
      marker.data = { ...(marker.data ?? {}), op: "regenerate", regenSwitchTo: page.index };
      let event;
      try {
        event = agent.session.append("user/message", marker, {
          surfaceOp: { op: "replace", startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
          sourceEventSeqs: [...plan.shadowedSeqs]
        });
      } catch (error) {
        return { kind: "error", text: t("regen.failed", { error: error instanceof Error ? error.message : String(error) }) };
      }
      let restore = "";
      if (mode === "both" && artifactTracker !== void 0) {
        try {
          const snapNote = await artifactTracker.recordSnapshotForRegenerate(sessionId, plan.targetSeq);
          const q = await artifactTracker.restore(sessionId, plan.targetSeq, event.seq);
          if (fs !== void 0 && (q.restoredPaths.length > 0 || q.quarantinedPaths.length > 0)) {
            await syncRestoreObservations(ctx, fs, agent, { restored: q.restoredPaths, deleted: q.quarantinedPaths });
          }
          const bits = [];
          if (q.restored > 0) bits.push(t("restore.count", { count: q.restored }));
          if (q.quarantine > 0) bits.push(t("artifact.moved", { count: q.quarantine, dir: q.dir ?? "" }));
          if (q.skipped > 0) bits.push(t("artifact.unbacked", { count: q.skipped }));
          if (snapNote !== "") bits.push(snapNote);
          if (bits.length > 0) restore = t("artifact.prefix") + bits.join(t("sep.list"));
        } catch (error) {
          ctx.logger.warn("[dsh-any-rollback] artifact switch failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
      return {
        kind: "success",
        text: t("regen.switched", { index: page.index, total: page.total, targetSeq, restore }),
        sourceEventSeq: event.seq
      };
    } finally {
      inflight.delete(sessionId);
    }
  }

  function latestUserSeqOf(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "user/message") return events[i].seq;
    }
    return 0;
  }
  function extractUserText(event) {
    const content = event?.data?.message?.content ?? event?.data?.content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  }


  const regenHandler = withHostLocale((invocation) => {
    const raw = String(invocation.input ?? "").trim();
    if (raw === "help") {
      return { kind: "success", text: t("regen.usage") };
    }
    // Empty input from the assistant-row button means "the latest turn": find
    // the newest user message and re-generate from it.
    const effective = raw === "" ? "@" + String(latestUserSeqOf(invocation.agent.session.snapshotEvents())) : raw;
    const mode = "both";
    if (raw === "list") {
      const { agent } = invocation;
      const events = agent.session.snapshotEvents();
      const lines = [];
      for (const event of events) {
        if (event.type !== "user/message" || event.data?.op !== "regenerate") continue;
        const cited = Array.isArray(event.data.sourceEventSeqs) ? event.data.sourceEventSeqs : [];
        lines.push("  #" + event.seq + "  回退点=" + (cited[0] ?? "?") + "  切换=" + (event.data?.regenSwitchTo !== void 0 ? "v" + event.data.regenSwitchTo : "重新生成"));
      }
      return { kind: "success", text: lines.length > 0 ? t("regen.list", { count: lines.length }) + "\n" + lines.join("\n") : t("regen.listEmpty") };
    }
    const pageMatch = raw.match(/^v(\d+)$/i);
    if (pageMatch !== null) {
      const { agent } = invocation;
      const want = Number(pageMatch[1]);
      // choose the newest regenerate marker before resolving; the target is the
      // prompt it rewound to
      const events = agent.session.snapshotEvents();
      const markers = events.filter((e2) => e2.type === "user/message" && e2.data?.op === "regenerate");
      const marker = markers[want - 1] ?? markers[markers.length - 1];
      if (marker === void 0) return { kind: "error", text: t("regen.listEmpty") };
      const cited = Array.isArray(marker.data?.sourceEventSeqs) ? marker.data.sourceEventSeqs : [];
      const targetSeq = cited[0];
      if (!Number.isSafeInteger(targetSeq)) return { kind: "error", text: t("regen.listEmpty") };
      return executeRegenSwitch(ctx, store, fs, invocation, targetSeq, { index: want, total: markers.length }, mode, inflight, checkpointingEnabled());
    }
    return executeRegenerate(ctx, store, fs, invocation, effective, mode, inflight, checkpointingEnabled());
  }, "dsh-any-rollback regen");

const rewindHandler = withHostLocale(
      (invocation) => handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config))
    );
    const engineHandler = withHostLocale(
      (invocation) => invocation.rawInput.trim() === "" ? Promise.resolve({ kind: "error", text: t("engine.rejected") }) : handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config))
    );
    try {
      yield ctx.commands.register({
        name: "rewind",
        description: t("command.description"),
        handler: rewindHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "rewind", error);
    }
    try {
      yield ctx.commands.register({
        name: "undo",
        description: t("command.undoDescription"),
        handler: rewindHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "undo", error);
    }
    try {
      yield ctx.commands.register({
        name: ENGINE_COMMAND,
        description: t("engine.description"),
        input: { hint: t("engine.inputHint") },
        handler: engineHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, ENGINE_COMMAND, error);
    }
    try {
      yield ctx.commands.register({
        name: "snapshot-auto-cleanup",
        description: t("cleanup.description"),
        input: { hint: t("cleanup.inputHint") },
        handler: withHostLocale((invocation) => handleSnapshotCleanup(store, invocation, dshHome, trackedBySession))
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "snapshot-auto-cleanup", error);
    }
    try {
      yield ctx.commands.register({
        name: "regen",
        description: t("regen.description"),
        input: { hint: t("regen.usage") },
        handler: regenHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "regen", error);
    }
  }, "dsh-rewind command");
  ctx.on("agent/created", ({ agent }) => {
    const session = agent.session;
    if (isSubagentSession(session)) return;
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return;
        store.setFormatVersion(session.header.version);
        try {
          await store.assertKnownStoreVersion(session.id);
        } catch (error) {
          ctx.logger.warn(`[dsh-rewind] file restore disabled for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (lifecycle.signal.aborted) return;
        const result = await store.reconcileFormatVersion(session.id, session.header.version);
        if (result.cleared) {
          ctx.logger.warn(`[dsh-rewind] cleared snapshots for ${session.id}: session format changed (v${session.header.version})`);
        }
        if (typeof session.header.cwd === "string") artifactCwds.set(session.id, session.header.cwd);
        if (artifactTracker !== void 0) {
          void artifactTracker.ensureBaseline(session.id);
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] session-format reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, { global: true });
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/end") {
      if (isSubagentSession(session) || artifactTracker === void 0 || !isFileCheckpointingEnabled(config)) return;
      const events2 = session.snapshotEvents();
      let keySeq2 = 0;
      for (let i = events2.length - 1; i >= 0; i--) {
        if (events2[i].type === "user/message") {
          keySeq2 = events2[i].seq;
          break;
        }
      }
      if (keySeq2 > 0) void artifactTracker.onTurnEnd(session.id, keySeq2);
      return;
    }
    if (event.type !== "user/message") return;
    if (isSubagentSession(session)) return;
    if (inflight.has(session.id)) return;
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return;
        const sessionId = session.id;
        void maybeRunAutoCleanup(ctx, store, sessionId, dshHome, config?.autoSweepIntervalMs, lifecycle.signal);
        if (!isFileCheckpointingEnabled(config)) return;
        let tracked = trackedBySession.get(sessionId);
        if (tracked === void 0) {
          tracked = await store.trackedPaths(sessionId);
          trackedBySession.set(sessionId, tracked);
        }
        if (tracked.size === 0) return;
        if (lifecycle.signal.aborted) return;
        await reconcileTracked(store, sessionId, event.seq, tracked);
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] boundary re-check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, { global: true });
  ctx.inject(["connection"], (scope) => {
    try {
      const connection = scope.root.connection;
      if (connection === void 0) return;
      const dispose = connection.rpc.handle(
        REWIND_RPC_CHANNEL,
        createRewindRpcHandler(
          store,
          () => scope.get("agents"),
          () => isFileCheckpointingEnabled(config)
        )
      );
      scope.effect(() => dispose, "dsh-rewind RPC channel");
    } catch (error) {
      ctx.logger.warn(`[dsh-rewind] RPC channel registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  ctx.inject(["fs", "workingDirectory"], (scope) => {
    const fs = scope.fs;
    const workingDirectory = scope.workingDirectory;
    fsService = fs;
    scope.effect(() => () => {
      fsService = void 0;
    }, "dsh-rewind fs capture");
    scope.on("tools/execute", async (exec, next) => {
      try {
        if (isFileCheckpointingEnabled(config)) {
          await captureBefore(fs, workingDirectory, store, exec, pending);
        }
        if (artifactTracker !== void 0 && exec.agent !== void 0) {
          try {
            artifactCwds.set(exec.agent.session.id, await workingDirectory.ensure(exec.agent, exec.signal));
          } catch {
          }
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return next();
    });
    scope.on("tools/post-execute", async (exec, result, next) => {
      try {
        const session = exec.agent?.session;
        if (session !== void 0 && !isSubagentSession(session)) {
          void maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal);
        }
        await commitEntry(store, pending, anchorCache, trackedBySession, exec, result, isFileCheckpointingEnabled(config));
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return next();
    });
    scope.on("tools/result", (exec) => {
      const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
      const capture = pending.get(key);
      pending.delete(key);
      void discardCapture(capture);
      return void 0;
    });
  });
}
export {
  Config,
  DEFAULT_FILE_CHECKPOINTING_ENABLED,
  ENGINE_COMMAND,
  SnapshotStore,
  apply,
  inject,
  name,
  profileEntryKey
};
