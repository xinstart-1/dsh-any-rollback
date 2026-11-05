# 更新日志

## [0.19.1-any.25] - 2026-11-05

**回退时总是覆盖输入框**：输入框里已有内容时，也会用被撤回的那句话替换。

### 原因

`runRewindAndFill` 里有一条跳过判据：`if (composerText().trim() !== "") return`。
只要输入框里有任何文字（自己打的草稿、上一次回退填进去的旧文字），
被撤回的那句话就不会填进去 —— 与 README「输入框自动填回被撤回的那句话」的
承诺不符，用户看到的现象就是「回退不覆盖输入框」。

这条判据还有两个附带问题：

- 它读的是**全局第一个** `[data-composer-input]` 的 `textContent`，而写入走的是
  按会话作用域的 `conversation.input.for(scope).setDraft` —— 多会话/多视图时
  判据与写入对象根本不是同一个输入框；
- 只有附件、只有 `@` 引用 chip、或草稿是纯空白时，判据结果都不可靠。

### 修复

| 位置 | 改动 |
| --- | --- |
| `lib/client.js` `runRewindAndFill` | 删掉 `composerText().trim() !== ""` 跳过；回退成功后一律填回 |
| `lib/client.js` `setComposerText` | 覆盖前先经 `composerFacade().readDraftText()` 读**本会话**草稿（宿主 `input.snapshot.draft`，比全局 DOM 读框可靠）；替换成功且原来确有文字时，用 `refill.replaced` 提示「已替换输入框原有内容」，不静默丢草稿 |
| `lib/client.js` 三语词典 | 新增 `refill.replaced`（en/zh/ja） |

保留不变的约束：

- 只对**主视图会话**回填（`isMainViewSession`），多窗口下不会填错会话；
- 回退命令失败 / 未匹配 / 抛异常 / 超时 / outcome 非 success 时**一律不写输入框**；
- 纯图片消息只恢复图片、不写空文字；目标文字为纯空白时按原样写入；
- 附件（图片 chip）不随文字一起替换：被撤回消息的图片会追加进来，原有附件仍在，
  由用户自行移除 —— 避免在回填路径上误删用户尚未发送的附件；
- `retractPending`（撤回待发送消息）的「非空草稿不覆盖」策略**保持不变** ——
  那条路径保护的是用户尚未发送的内容，语义与回退不同。

### 测试

新增 `tests/rewind.refill.mjs`（29 项），用真实函数源码 + 假宿主输入面覆盖：

- 输入框非空时覆盖（本次修复的正面用例）、为空时照旧填回；
- 失败/未匹配/抛异常/超时一律不写；非主视图不写；
- 纯图片只恢复图片；写入通道不可用时返回 false 且不抛；
- 替换原有草稿时给出提示，纯空白草稿不算「原有内容」。

把 `lib/client.js` 回退到 any.24 后该测试有 2 项变红（`写入了一次输入框`、
`写入的是被撤回的那句话`），确认它钉住的是真实缺陷而非镜像实现。

全部 15 个测试文件：14 通过 / 1 跳过 / 0 失败。

## [0.19.1-any.24] - 2026-11-05

**移除版本切换控件**：只显示最新版，不再展示旧版。

### 原因

纯前端「显示旧版」与宿主模型上下文必然脱节 —— 切到旧版后继续提问，模型仍按
最新版回答，回答会落在最新位置；任何前端补丁都无法让模型接着旧版走。
用户决定去掉这个能力，避免误导。

### 移除内容

| 类别 | 具体 |
| --- | --- |
| 槽位 | `conversation.chat.assistant-actions` 的 `regen-versions` 条目与 `AssistantVersionSwitcher` 组件 |
| 状态 | `createVersionState` / `versionStateFor` / `versionStates` / `sameSelections` |
| 重绘 | `selectVersionFor` / `repaintSession` / `healSessionBuilder` / `buildingSessionId` 游标 / `liveBuilders` |
| 分组 | `versionGroupsOf` / `groupAtAnchor` / `isAnchorVisibleInGroup` / `versionGroupsForChat` / `humanUserSeqsOf` |
| RPC | `versionsOverRpc` / `isVersion`（客户端不再调宿主 `versions` 端点） |
| 样式/文案 | `dsh-rewind-versions*` CSS 类、`regen.versionLabel/Aria/Prev/Next` 三语文案 |
| 测试 | 删除 5 个针对切换的测试文件；`tests/regen.rewind-visibility.mjs` 改回 cuts 模型 |

### 保留

- **`↻` 重新生成按钮**（发 `/regen @seq`）不变。
- **回退/重生成后撤下的旧内容仍然隐藏**：`deriveOne` 直接按遮蔽区间
  `[target, marker]` 判定 —— 区间内隐藏，区间外（重发的提示词、新回答、
  以及之后用户新提的问题）一律可见。也就是「永远只显示最新版」。
- 客户端半边因此精简：`lib/client.js` 从 2780 行降到 2312 行。

### 测试

新增 `tests/regen.no-version-switch.mjs`（40 项）钉死移除结果与保留行为：

- 不再注册 `regen-versions`；注入面不再暴露 `versionGroupOf` / `usePages`
- 22 个旧符号全部确认已删除（不留死代码）
- CSS 与三语文案一并清掉
- `↻` 按钮与 `/regen` 命令仍可用
- 撤下的提问/回答隐藏，重发的提问、重生成的回答、**之后的新提问**均可见

全部 14 个测试文件：13 通过 / 1 跳过 / 0 失败。

## [0.19.1-any.23] - 2026-11-05

修两个用户实测问题，都出在同一个根因：**版本组的跨度被写成了无界**。

真实会话 `session-2d80c3ab` 有 4 个版本组（标记 23/44/59/75 → 组 #10/#29/#50/#65），
之后用户在 seq 94 又提了一个新问题（rpcId 是普通 uuid，不是插件重发）。

| 现象 | 原因 |
| --- | --- |
| 「切换按钮显示在最新对话了」 | 每组最后一页写死成 `[marker_N+1, ∞)`，于是组之后的**一切**（含新提问的回合）都被算进老组的「最新版」，控件跟着跑到新对话下面 |
| 「切到第一个对话继续问，回答跑到第二个对话」 | 同上：新提问的回合被当作老组的「第 N+1 页」，选中老版本时被一起隐藏；而模型的上下文从来是最新版，回答自然落在最新位置 |

### 修复

- 组跨度有界：`spanEnd = min(下一个组的 target, 最后一个标记之后的第一个真实人类提问)`。
  组之后的新对话不再属于任何版本组 → 恒可见，也不承载版本控件。
- 新增 `humanUserSeqsOf(nodes)`：只认真实人类提问（`source.kind === "user"` 且
  `rpcId !== RESEND_RPC_ID`），排除运行时注入与插件重发提示。
- 控件归属改为**客户端几何**（`versionGroupOf(messageId)` → `versionGroupsForChat(chat)`），
  不再走宿主 `versions` RPC 判归属。两边各算一套坐标必然出现偏差，且 RPC 往返期间控件空白。
  `versionGroupsForChat` 按 chat 快照对象 `WeakMap` 记忆化，快照重建即失效。
- 上下文真的前进时（新的回退/重生成，或用户接着提问）**把版本选择清回最新**：
  避免界面停在旧版而新内容属于新的一轮。用「上次签名是否存在」判定首次计算，
  builder 重建时第一次调用绝不清选择，否则每次重绘都会抹掉用户的切换。
- 删除死代码 `selectVersionPages()` 与 `versionPagesCache`。

### 测试

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/regen.three-groups.mjs`（按新模型重写） | 50 | 真实 4 组几何：跨度有界、组不重叠、**新提问 94/95 不属于任何组且选中老版本时仍可见**、每组页数与宿主一致 |
| `tests/regen.selection-persist.mjs` | 22 | 重绘/重建/增量刷新不清选择；**结构前进时清回最新**（刻意行为） |
| `tests/regen.version-switch-wiring.mjs` | 62 | 组件改用 `versionGroupOf` 的契约 |
| `tests/regen.version-ownership.mjs` | 9 | 归属判据换成客户端几何 |

全部 18 个测试文件：17 通过 / 1 跳过 / 0 失败。端到端渲染 21 项、引导冒烟 24 项，均通过。

### 已知边界

版本切换仍是**纯前端显示**：模型的上下文始终是最新版。因此「切到旧版后继续提问」
无法让模型接着旧版回答 —— 现在的行为是：一旦新内容落盘（含用户新提问），视图自动
回到最新版，避免显示与上下文脱节。若需要真正「从旧版继续」，得走宿主侧 `/regen v<N>`
（会重跑模型）。

## [0.19.1-any.22] - 2026-11-05

修两个用户实测问题：回退弹窗报「无法获取影响清单：t is not defined」，以及切回第一版后
版本控件消失（标签不常驻）。

### 一、`t is not defined`（回退弹窗）

`lib/client.js` 的 `previewOverRpc()` 与 `knownPreviewErrorText()` 都在**模块顶层**，
却直接调用了 `t(...)`；而 `t` 是 `apply()` 生成器里由 `ctx.locale.bind()` 创建的
**局部变量**。于是只要走到本地化分支就抛 `ReferenceError`，再被
`previewOverRpc` 的 `catch` 当成字符串透给界面 —— 用户看到
「无法获取影响清单：t is not defined」，影响清单永远出不来。

修复：把 `t` 作为显式参数传入 `previewOverRpc(…, translate)` /
`knownPreviewErrorText(error, seq, translate)`，`apply()` 里注册时传 `t`。
另加静态检查脚本 `scratch/find-t-scope-bugs.mjs`（扫描「顶层函数裸调 t()」），
当前仓库 0 命中。

### 二、切回旧版后控件消失（标签不常驻）

真实会话 `session-2d80c3ab` 有 **3 个版本组**（标记 23→组#10、44→组#29、59→组#50，
用户连做了两次 regen）。两条原因：

1. **自愈触发 rebuild 循环**：`0.19.1-any.21` 引入的 `reapply` 无条件调用
   `repaintSession()`，而控件每次挂载都会调它 → `rebuild` 又可能让控件重挂载 →
   重建循环，标签一闪一闪。改为 `healSessionBuilder()`：**builder 已接上
   `readSelection` 就直接返回 false**，全程最多自愈一次。
2. **首帧空白**：控件原先在 `useEffect` 里拿分页、再用 `setState` 回填组键与页数，
   RPC 往返期间 `versions.length < 2` → `return null`，视觉上就是控件消失。
   改为：新增纯函数 `selectVersionPages(list, targetSeq)` 在**渲染期**算组键与页数，
   并加会话级 `versionPagesCache`，重挂载时首帧直接用缓存渲染。

顺带把「组归属 + 组内页序」逻辑集中到 `selectVersionPages()`，组件里不再有
异步 `setGroupTarget`。

### 测试

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/regen.three-groups.mjs`（新增） | 32 | 真实 3 组会话：每组页数与宿主一致、5 条回答各自归属正确、**切成旧版后仍有可见回答承载控件**、自愈幂等、首帧缓存 |
| `tests/regen.preview-error.mjs` | 21 | `t` 改为显式参数后仍按错误码本地化；另断言 `apply` 把 `t` 传进 `previewOverRpc` |

全部 18 个测试文件：17 通过 / 1 跳过 / 0 失败。
端到端渲染 21 项、引导冒烟 24 项、选择不被重绘清掉 17 项，均通过。

## [0.19.1-any.21] - 2026-11-05

`0.19.1-any.20` 的加固。20 版修好了「点击没反应」的主链路，但复查又发现两处会让
选择「看起来生效、随即失效」的隐患，以及一个会话重开的不一致。逐一钉死后补了
`tests/regen.selection-persist.mjs`（20 项）长期守住。

### 隐患一：重绘时把选择复位（旧代码遗留陷阱）

旧 `refreshCuts()` 里有：

```js
if (before !== this.cutSignature && this.selectedVersion !== void 0) {
  this.selectedVersion = void 0;
}
```

而 `rebuild` 会重建 builder、`replace()` 又会走到 `refreshCuts()`。这段复位一旦留下，
结果就是「点一下确实变了，紧接着的重绘把它抹回去」——用户看到的依然是没反应。
现已确认新实现不包含任何复位，`refreshCuts()` 只从会话级状态**重读**选择。
测试覆盖：同一 builder 连续 replace 三次、builder 重建三次、`apply()` 增量路径、
以及新的回退落盘后（`cutSignature` 确实变化）选择仍然保留。

### 隐患二：rebuild 调用链的同步性

会话游标 `buildingSessionId` 依赖「`binding.rebuild()` 内部同步走到 `create()`」。
已从宿主侧确认这条链全程同步，游标不会在 `create()` 之前被清掉：

`rebuild()` → `rebuildRegistry()` → `resetViewBuilders()`（清空 `views`）
→ `replaceWindow(...)` **返回 `"immediate"`** → `publish("immediate")` → `cancelFrame()`
→ `flush()` → `updateView(view, true, …)` → `view.definition.create()`

### 隐患三：会话重开后正文与标签不一致

`resetViewBuilders()` 也会在 assembler **构造函数**里执行。所以「关掉会话再打开」时，
Chat builder 是在我们设游标**之外**建出来的 —— 拿不到 sessionId、读不到选择，
正文停在最新版，而标签仍是「第 1/2 版」。新增自愈：注入面提供 `reapply()`，
组件挂载时若该组已有非默认选择就补一次 repaint，让新 builder 在游标内重建并接上选择。

### 测试

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/regen.selection-persist.mjs`（新增） | 20 | 选择不被 replace / apply / builder 重建 / 新回退清除；游标外 builder 退化不崩；重开自愈 |
| 其余 16 个文件 | — | 全绿 |

全部 17 个测试文件：16 通过 / 1 跳过（环境缺会话日志）/ 0 失败。
另跑两个端到端脚本：真实加载 `lib/client.js` 的渲染验证 21 项、引导冒烟 24 项，均通过。

## [0.19.1-any.20] - 2026-11-05

修复「版本切换控件有显示、点击 ‹ › 毫无反应」（用户截图：`‹ 第 2/2 版 ›` 清晰可见，
但点两侧箭头画面不变）。

三个独立断点叠在一起，任何一个单独存在都会让点击变成无声空操作：

| # | 断点 | 说明 |
| --- | --- | --- |
| 1 | `create()` 包装器拿不到 sessionId | 宿主以 `view.definition.create()` **无参**调用（`conversation-client` 的 `updateView`），旧实现猜 `args[0]` 是字符串 → 永远 `undefined` → `liveBuilders` 恒空 → `selectVersionFor()` 直接 `return false` |
| 2 | 注入面没有 `hooks` 座位 | `inject(sessionId)` 每个「条目 × 会话」只求值一次且返回值不更新；没有 `hooks` 键就没有 `useSyncExternalStore` 订阅，组件渲染期读的 `currentVersion()` 永远不变 |
| 3 | 只改 builder 内部状态不重绘 | 视图订阅的是 `BoundConversation.snapshot`，只在 assembler `flush()` 时写入；`builder.replace()` 的返回值只落到 `view.snapshot`，无人订阅 |

标签恰好显示「第 2/2 版」正是断点 1+2 的指纹：`currentVersionFor()` 返回 `undefined`，
`active` 回退到 `total`，于是永远不会是别的数字。

### 修复

- **会话坐标**：`repaintSession()` 在 `binding.rebuild()` 期间设置模块级游标
  `buildingSessionId`，`create()` 包装器据此拿到 sessionId（rebuild 调用链同步，
  游标安全）。拿不到时仍照常包装，只是不参与按会话切换。
- **响应式座位**：`inject` 返回 `hooks: { pages: versionStateFor(sessionId) }`，
  宿主按 `use${Capitalize}` 转成 `usePages`，组件用
  `usePages((view) => view)` 订阅，切页后标签与画面同步重绘。
- **真正生效**：`selectVersionFor()` = 写可观察状态（触发重绘）+ `binding.rebuild()`
  （重跑派生 → `publishViews` → `store.publish` → 视图更新）。纯前端，不发命令、
  不重跑模型、不碰宿主二进制。失败时 `rewindLog.warn` 而非静默 `return false`。
- **页数模型改为 N+1（关键）**：旧模型「每个遮蔽标记 = 一版」共 N 版，第 1 版是最早
  那段被撤下的区间；宿主 `versions` RPC 是「原始版 + 每个标记一页」共 **1+N** 页。
  两边差一页且首尾错开，控件把宿主页号直接当 cut 下标用 → 选中页永远落在不存在的
  区间上 → 画面纹丝不动。新模型 `versionGroupsOf()`：
  `[target, marker₁]` / `[marker₁+1, marker₂]` / … / `[marker_N+1, ∞)`，与宿主严格对齐。
- **多组不再混页**：真实会话可能同时有多个版本组（回退 @10 后又重生成 @29）。旧判据
  按区间过滤会把别的组的「原始版」一并捞进来（实测 `10o,29o,29` 三页混组、页序错乱，
  点 › 会切到另一组）。新判据先定组（`target ≤ 提示词` 里最大的 `targetSeq`，与
  `versionGroupsOf` 的 `cut.target` 同源）再取组内分页。
- 删除死代码 `isOriginalVersionSelected()`（全仓仅自身定义一处引用）与旧
  `isAnchorVisibleInCut()` / `annotateVersionCuts()` / `currentVersionFor()`。

### 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/regen.version-switch-wiring.mjs`（新增，61 项） | 三个断点逐条钉死：可观察状态语义、`selectVersionFor` 写状态+rebuild、rebuild 期间游标可见、`usePages` 标签算法、源码契约、真实调用序列、真实会话几何、多组不混页 |
| `tests/regen.switch.mjs`（重写，46 项） | N+1 分页模型：区间切分、默认显示最新页、选第 1 页恢复原始回答、越界夹取、多组独立 |
| `tests/regen.rewind-visibility.mjs`（24 项） | 切页语义改为「选第 1 页=回到第一次回答」（重生成追加的内容属第 2 页，须隐藏） |
| `tests/regen.version-ownership.mjs`（12 项） | 组归属判据换成「先定组再取页」，兜底路径仍保留区间判据 |

全部 16 个测试文件：15 通过 / 1 跳过（环境缺会话日志）/ 0 失败。

## [0.19.1-any.19] - 2026-11-04

修复「快照目录无声涨到 40+ GB」的存储结构性缺陷（用户实测：C 盘 5 天少了 61 GB，
`~/.dsh/rewind-snapshots` 一项就占 43.8 GB）。

实测数据（`scripts/snapshot-doctor.mjs` 对真实目录只读分析）：

| 指标 | 数值 |
| --- | --- |
| 会话 / blob 文件 / 清单 | 60 / 103,784 / 370 |
| blob 总字节 / 唯一内容 | 41.81 GiB / **15.45 GiB** |
| 跨会话纯重复 | **26.36 GiB**（76,414 份冗余副本） |
| 无任何清单引用的孤儿 blob | 763 MiB |
| 安全可释放 | **27.11 GiB** |

根因（4 条，均已在代码里修复）：

1. **blob 按会话各存一份、从不跨会话共享**：`cacheContent` 只查本会话
   `artifacts/blobs/<hash>`，GC 可达性也只看本会话清单。同一份 64 MiB 产物在 N 个
   会话里存 N 份 —— 这是 26 GiB 重复的直接来源。
2. **没有任何总量上限**：所有 `maxFileBytes` / `artifactMaxFileBytes` 都是单文件上限，
   全仓字节数、会话数、隔离区体积都没有上限；`quarantine/` 与 regen 预快照完全不回收。
3. **自动清理形同虚设**：`autoCleanupEnabled` 默认 `false`，按「闲置 30 天」判定，
   而 3 天内产生的数据一条都不满足；`autoSweepChecked` 还是进程级布尔锁，整个 DSH
   进程只扫一次，之后跑多少会话都不再清理。
4. **文案里写了、代码里没有**：`max-total` / `compact` / 「跨会话去重的全局 blob 仓」
   只有 i18n 字符串，没有 Config 字段、没有命令分支、没有实现（死代码）。

### 修复

- 新增 `lib/blob-store.js`：**全局内容寻址仓** `<root>/_blobs/<hash[0:2]>/<hash>`。
  按 sha256 分片、全机一份字节；`putFromTemp` 复核哈希后原子 rename，`ensureLocal`
  只读地回退到旧版每会话目录（升级前数据仍可还原）；`adopt` 用硬链接把历史副本
  收编进全局仓；`collectGarbage` 按**全局**可达性回收。所有 hash 名严格校验 64hex，
  逐层 `lstat` 防符号链接越界。
- `lib/artifact-track.js` 接入全局仓：`cacheContent` / `blobPath` / `collectGarbage`
  全部改走 `BlobStore`；新增 `compactIntoGlobal` / `globalCollectGarbage` / `globalBlobStats`。
  旧清单里的 hash 不需要改写即可读到全局副本。
- `lib/index.js`：补上 `autoCleanupMaxTotalGb`（默认 8 GiB）与 `autoCleanupCompact`
  两个 Config 字段；实现 `max-total <GB>` 与 `compact [--apply]` 命令；`run` 现在
  「清理 + 压缩」一起做；配额淘汰按最旧会话整组进行，**含隔离区 / rescue / .pending
  的会话绝不淘汰**；自动清理改为按状态文件时间节流（不再一进程只扫一次），压缩
  最短间隔 1 小时，避免每回合全量扫描几十 GiB。
- 修掉 3 个实测回归（均属此前未提交的跨会话归属重写引入）：`restore()` 的 TOCTOU
  复核不认 `UNKNOWN_HASH`（新建大文件恒判 unknown、隔离区为空）、清单链断裂时新产物
  恒判 `unowned`、以及「B 在基线前改过文件」时账本为空导致 A 的回退覆盖 B 的改动。
  现在账本与「别的会话清单哈希」两条证据并行，任一判 foreign 即跳过。
- 新增 `scripts/snapshot-doctor.mjs`：默认只读体检 / 预演，`--apply --dedup --gc --yes`
  才执行；跨会话硬链接去重（逐份校验 sha256、保留审计日志 `dedup-log.jsonl`）、
  删除孤儿 blob、绝不触碰 `quarantine/` / `rescue/` / `.pending/` / 清单 / 检查点。
- 新增 `tests/blob-store.integration.mjs`（30 项）：锁定「相同内容全机一份」、旧数据
  可读可收编、dry-run 不写盘、非法 hash 拒绝、GC 全局可达性与字节上限。

### 测试

- `node tests/run-all.mjs`：15 个文件，14 通过 / 1 按约定跳过（依赖本机历史会话日志，
  缺失时打印 SKIP 而非假失败）/ **0 失败**。
- `node lib/blob-store.js` 自测 34/34 PASS。
- `node scripts/snapshot-doctor.mjs` 对真实 43 GB 目录只读预演：报告可释放 27.11 GiB。

## [0.19.1-any.18] - 2026-11-04

修复两个实测确认的缺陷：一是**回退会跨会话污染**（严重，已造成真实数据被撤销），
二是**首次「重新生成」后看不到版本切换控件**。

### 修复

- **回退不再改动其他会话的文件。** artifact 清单按工作区（cwd）全量扫描，同一目录下
  开多个会话时各自都记录「整个工作区在某时刻的样子」。回退只应撤掉**本会话造成的
  改动**，但旧实现直接按本会话清单对齐整个工作区 —— 实测一次回退把另一个会话改出来
  的 78 行改动和两个测试文件一起撤掉（还原成旧内容 / 移入隔离区）。
  现在 `plan()` 会先做**跨会话检测**：同一 cwd 里其他会话在本会话目标点之后记录过
  该路径、且记录的 (size, mtime) 与本会话目标状态不同，即判定「被别人动过」，一律
  不动（计入 skipped，原因 `foreign-session`）。检测本身失败时保守处理：宁可不回退
  文件，也不误伤别的会话。
- **首次 /regen 后立刻出现 ‹ 1/2 › 版本切换控件。** 旧实现只把「被 regen 标记遮蔽的
  页面」算作版本，第一次重新生成只写 1 个标记 → 版本数恒为 1 → 客户端
  `if (versions.length < 2) return null` 永远不渲染，与「点了重新生成就该能切版本」
  的预期相反。现在宿主会把每个被 regen 过的提示词的**原始回答**作为第 1 版补进来，
  首次 regen 即得到 2 版。
- **原始版可真正切回。** 客户端分组边界改为只由真实标记（`markerSeq > 0`）决定，
  原始版恒属于本组；选中第 1 版时原始回答重新可见。

### 测试

- 新增 `tests/fixes.version-and-isolation.mjs`（13 项）：覆盖首次 regen 版本数、
  无 regen 时不凭空出版本页、两次 regen 得 3 版、跨会话隔离（A 的改动被回退、
  B 的改动保持原样）、单会话不误伤。
- 全量回归 13 个测试文件、**270 项断言全部通过**。

## [0.19.1-any.17] - 2026-11-04

优化回退失败提示的文案。

原问题：`无法获取影响清单：user message at seq 127 is no longer in the model
context (shadowed by compaction)` —— 内层是宿主英文原文没本地化；
"shadowed by compaction" 说法错误（实际是被后续回退/重生成撤下）；
也没告诉用户下一步该做什么。

修复：
- 宿主 `planRewind` 的 not-on-surface 文案改为准确描述 + 可操作建议。
- 客户端 `previewOverRpc` 不再把 `error.message` 当界面文案，新增
  `knownPreviewErrorText()` 按错误码（含旧宿主文案特征）映射到本地化文案，
  英文原文只进日志；未知错误仍回退到宿主原文，不臆测。
- 新增三语文案 5 条（`previewError.*`），新增测试 20 项。

效果：「无法回退到 #127：这条消息已被后续的回退或重新生成撤下，不再属于
模型看到的对话。请选一条仍在显示的消息。」

## [0.19.1-any.16] - 2026-11-03

修复「重新生成后版本切换控件从不显示」。

根因：归属过滤用 `v.targetSeq === targetSeq` 严格相等，但服务端 targetSeq 是
marker 遮蔽区间里最小的被引用 seq（被撤下的原提示词），客户端反推的是 ↻ 重发
出来的新提示词 seq —— 永远不相等，过滤恒为空，控件 `return null`。

修复：归属判据改为几何区间「提示词落在该 marker 的重发区」
`(marker.endSeq, 下一个 marker.markerSeq)`。新增测试 8 项。

## [0.19.1-any.15] - 2026-11-03

修复「回退后『已完成，用时 N 秒』汇总行仍残留」。

根因：宿主 turn-process 行的锚点是合成值 `controlAnchorSeq - 0.1`（小数），
`nodeAnchorSeqOf` 用 `Number.isSafeInteger` 判断，小数被拒 → 返回 undefined →
`deriveOne` 直接放过该行。

修复：接受有限小数锚点，比较时按 `Math.floor` 归到整数边界。

## [0.19.1-any.14] - 2026-11-03

修复「回退时列出一大堆无关文件待删除」。

根因：产物清单 key 取错对象 —— `onTurnEnd` 取「最后一条 user/message」，实际
拿到运行时注入消息，seq 比人类提示词大。真实会话清单 keys=[0,42,51,74,83]，
而轮次起点是 [10,48,63,80]，完全错位 → 回退时退化到 5 小时前的清单。

修复：清单 key 复用 `isHumanUserMessageEvent`；`onTurnEnd` 接受
`session.header.cwd` 兜底修复注册竞态；`plan()` 增加清单链完整性诊断，
链断裂时降级为保守策略（mtime 下界）。新增测试 13 项。

## [0.19.1-any.13] - 2026-11-03

修复「回退后思考过程残留」：回退后仍有 `已完成，用时 N 秒` 汇总行和
`regen · fs is not defined` 失败命令行留在对话里。

### 修复

- **失败命令行的隐藏**：`command/done` 为 error 时没有 `sourceEventSeq`，
  既不算遮蔽区间来源、也进不了「已执行」判定，于是失败的回退/重生成命令
  （截图里的 `regen · fs is not defined`）永久残留。改为按命令名 + `error`
  一并隐藏；预览/候选探针仍照常显示。
- 回归测试补 `turn-process` 汇总行场景：`byTurn` 分组错误会让「同轮成员全隐藏
  则汇总行隐藏」的兜底失效（测试 fixture 曾把所有 user 节点塞进 turn 1）。

### 测试

`tests/regen.rewind-visibility.mjs` 扩到 22 项。用真实会话
`session-0a61f77f` 的完整事件序列重建宿主节点后验证：仅当前轮
（`u80`/`a85`/`p4`）可见，四个历史轮次的提示、回答、汇总行、命令节点全部隐藏。

## [0.19.1-any.12] - 2026-11-03

修复「回退后，上面的会话没有消失」。

### 修复

- **可见性模型倒挂**：`isAnchorVisibleInCut` 把「最后一版」的遮蔽区间当作默认可见，
  而区间内其实全是已撤下的旧内容（当前内容在标记之后）。改为区间默认隐藏，只有
  通过版本切换控件主动选中某版时才显示该版区间。
- **裸 `/regen` 算不出遮蔽区间**：`args` 为空时旧实现直接跳过该命令，导致那次
  重生成遮蔽的记录永远不隐藏。客户端现在镜像宿主的空输入语义（目标 = 标记之前
  最新一条人类用户消息，排除运行时注入与插件重发提示），推导出区间。
- **节点定位**：`deriveOne` 改用与 ↻ 按钮同源的 `nodeAnchorSeqOf`（`data.seq` →
  `data.finalNode.seq` → `anchorSeq`），真实会话里 assistant-step 的 seq 在
  `finalNode` 上。
- **一次性迭代器**：`rewindCutsOf` 对同一集合做两次遍历，调用方传 `Map.values()`
  时第二次拿空集合。先物化为数组。
- 已执行的 `regen` 命令行节点与被撤下区间一起隐藏（此前只隐藏引擎命令）。

### 测试

- 新增 `tests/regen.rewind-visibility.mjs`（16 项）：用事故会话的真实节点序列复现
  「回退后旧回答仍在」，覆盖 replace 全量重建与 apply 增量两条路径。
- `tests/regen.cuts.mjs` 增补裸 `/regen` 目标推断用例（16 项）；
  `tests/regen.switch.mjs` 改为新区间模型（22 项）。全部 11 个测试文件通过。

## [0.19.1-any.4] - 2026-11-02

新增「重新生成」与「版本切换」能力（命令形态），详见 docs/regen.md。

### 新增

- **\/regen <序号|@seq>\**：回退到指定消息所在轮次，产物先快照，然后**自动重发原提示词**
  ——模型重新回答并重跑命令，产物随之更新。旧回答与旧产物保留（日志遮蔽 + 隔离区），可追溯。
- **\/regen list\**：查看本会话的重新生成历史（版本页）。
- **\/regen v<N>\**：切换到第 N 个版本，**产物联动对齐**（新版本文件进隔离区、旧版本还原），
  这是现有同类插件都缺的一环。
- 设计与边界记录在 \docs/regen.md\：发送走宿主侧 \gent.followup\（调研自 MIT 许可的
  dsh-retrace 项目，已致谢）；版本数据从日志推导，零新增存储。

### 说明

- 重新生成会真实触发一轮 AI 执行；旧版本仍占磁盘但不占模型可见面。
- 助手行翻页 UI 受宿主锚点限制暂未提供（详见 docs/regen.md），命令形态已完整可用。


## [0.19.1-any.3] - 2026-11-02

整体审计（还原路径、边界与失败路径）确认并修复的五个问题。

### 修复

- **还原目标位置变成目录时，用户数据不再被困。** 旧版会把该目录移入隔离区、还原失败，且不回滚；
  现在目录**整棵**移入隔离区（index.json 逐文件记录原因 \eplaced-by-restore\），随后还原照常完成。
- **还原流程的临时文件不再进入清单。** \.rewind-*.tmp\ 一旦被边界清单收录，下次回退会把它们
  当作「新建产物」隔离走。现在扫描跳过它们，还原结束时还会清扫上次失败遗留的临时文件。
- **落点清单不再沿用错误摘要。** \inishRestore\ 早先只比较文件大小就复用目标清单的摘要，
  同尺寸不同内容的文件会背上错误的 hash。现在要求 size 与 mtime 双重一致，否则写 null
  让下一次边界记录重新计算。
- **清单损坏时给出警告。** 清单 JSON 损坏意味着该时间点无法还原，旧版静默退化成「无动作」；
  现在输出包含会话与清单序号的警告。
- **隔离原因不再误导。** 目录整棵隔离时按实际内容记录，不再把所有文件标成 \created\。

### 测试

- 新增 \	ests/artifact-track.audit-fixes.mjs\（14 项断言）覆盖上述各项；
  既有的 \rtifact-track.regression.mjs\（12 项）与审计探针全部通过。


## [0.19.1-any.2] - 2026-11-02

修复上一版实测确认的四个缺陷，并补充回归测试。

### 修复

- **超上限文件不再被移出工作区。** 目标时刻已存在、但内容未备份且后来改动过的文件，
  旧版会按「新建产物」移入隔离区，看起来像文件被删。现在跳过并保持原样，回退结果中明确提示
  「N 个文件保持原样（目标时刻没有内容备份）」。目标时刻确实不存在的文件仍按原逻辑隔离。
- **同尺寸改写不再漏记。** 变化判定改为 mtime 精确比对，不再使用 1500 ms 容差，
  避免边界之后立刻发生的同尺寸改写沿用旧摘要、导致回退还原成更早版本。
- **内容缓存会回收。** 每轮清单裁剪后执行可达性回收，删除不再被任何存活清单引用的 blob
  与中断写入留下的 `.tmp-*` 临时文件。
- **点目录纳入追踪。** 默认不再跳过所有 `.` 开头的目录，只固定跳过 `.git`、`.hg`、`.svn`、
  `.dsh`、`.dsh-file-attachment`。`artifactExclude` 默认值相应精简为
  `node_modules,dist,build,out,coverage,__pycache__,venv,.venv,target`。

### 新增

- `tests/artifact-track.regression.mjs`：四个缺陷各一条回归用例（含「目标时刻确实不存在仍需隔离」
  的反向断言），共 12 项断言。

### 变更

- 包名由 `dsh-rollback` 改为 `dsh-any-rollback`（插件市场已有同名插件）。内部标识保持不变，
  已存快照仍可读。

## [0.19.1-rb.1] - 2026-11-02

首个公开版本。

### 功能

- **按消息回退对话。** 每条用户消息旁提供 ↶ 按钮，把该消息之后的内容从对话视图撤下，
  并把被撤回的消息填回输入框，改一改即可重新提问。同时提供 `/rewind`、`/undo` 命令。
- **同时还原工作区文件。** 回退时可只退对话、只退文件或两者都退；文件还原只从插件自己的备份目录读取，
  只写回真正备份过的内容。
- **追踪命令产出的文件。** 每个回合边界记录工作区清单（`路径 → 大小 + mtime + sha256`），
  只对发生变化的文件按内容摘要缓存；回退时逐文件还原或移入隔离区。
  覆盖渲染脚本、ffmpeg、构建与数据脚本产出的文件，而不只是编辑器改过的源码。
- **隔离区不删文件。** 回退时需要移出的文件一律移入 `quarantine/`，去向记入 `index.json`，可人工取回。
- **快照自动清理。** 提供 `/snapshot-auto-cleanup` 命令组（状态 / 开关 / 闲置天数 / 预演 / 执行），
  支持按会话单独清理。
- **插件页设置卡片。** 文件备份开关与清理策略可在 DSH 插件页直接设置，无需编辑配置文件。

### 配置项

- 文件备份：`fileCheckpointingEnabled`、`maxFileBytes`、`snapshotDir`。
- 命令产物追踪：`artifactTrackingEnabled`、`artifactMaxFileBytes`、`artifactBaselineContent`、
  `artifactExclude`、`artifactKeepManifests`。
- 自动清理：`autoCleanupEnabled`、`autoCleanupMaxAgeDays`。

### 兼容性

- 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`。
- 需要 Node.js `^22.19.0` 或 `>=24.0.0`。

### 说明

- 回退只改变对话视图，会话日志保持只追加，历史记录完整可查。
- 备份根目录与工作区分离，不受项目内清理脚本影响；删除它只丢失回退能力，不影响项目文件。
