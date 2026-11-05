# 严格安全审计：dsh-any-rollback v0.19.1-any.18

审计日期：2026-11-04 · 对象：`C:\Data\Project\dsh-forks\dsh-rollback`（含 `dist/` 发布包，已核对与 `lib/` 逐字节一致）
方法：4 名独立审计员分域通读 + 主审独立编写 6 组探针脚本，用**真实模块**（`ArtifactTracker` / 宿主 `index.js`）在临时目录实测复现。
所有结论均基于代码行号与实测输出，非推测。证据脚本位于 `scratch/`（未改动 `lib/` 与 `tests/`）。

---

## 0. 结论先行

**用户是对的：那个「严重跨会话污染」根本没被修掉，而且之前的审计方式根本不可能发现它。**

1. **CHANGELOG [any.18] 声称「回退不再跨会话污染」，但用当前仓库源码、按 CHANGELOG 自己描述的事故形状（B 的 78 行改动 + B 新建的两个测试文件）可以稳定复现：B 新建的两个测试文件仍被 A 的回退移进隔离区。** 修复只挡住了「已存在、且 size/mtime 都变了」这一条最窄路径。证据：`scratch/repro-cross-session-pollution.mjs`。
2. **更严重：`executeRewind` 顺序执行两套还原引擎，跨会话 guard 只加在第二套（ArtifactTracker）上；第一套 `store.restoreAfter()` 直接 `unlink`/覆盖字节，完全绕过 guard。** 即「artifact 侧所有保护都可能白做」。
3. **SECURITY.md 的核心信任边界是假的**：唯一写了包含性校验的 `toRel()` 是**死代码，全仓从未被调用**；所有路径构造走无校验的 `fromRel()`。已实测把清单 rel 写成 `../OUTSIDE-victim.txt` 即可让 `restore()` 把内容写到工作区外、把工作区外目录整棵移走。
4. **之前 270 项断言全绿却漏掉它，不是审计轮数不够，是每轮都在用同一种方法**：镜像实现（把宿主算法抄进测试再断言这份副本）、顺境 fixture、源码字符串断言、零端到端覆盖。**肇事的 `executeRewind → restore → plan → foreignTouchedPaths` 链路，全仓 15 个测试文件无一触达。**

按严重程度汇总：**P0 致命 7 项、P1 高 9 项、P2 中 8 项**。下面逐条给出行号、可复现场景、根因、修复建议。

---

## P0-1｜跨会话污染未修复：B 新建文件仍被 A 的回退删除（用户点名的问题）

**级别：致命（真实数据丢失，已实测）**
**位置**：`lib/artifact-track.js` `plan()` L601-609、`foreignTouchedPaths()` L543-551

**实测复现**（`scratch/repro-cross-session-pollution.mjs`，用真实模块）：
```
A 回退计划 actions : ["delete:test-a.mjs","delete:test-b.mjs"]
A 回退计划 skipped : ["foreign-session:src.js"]
B 的 78 行改动是否保留 : 是
B 的 test-a.mjs 是否保留: 否（被移入隔离区）
B 的 test-b.mjs 是否保留: 否（被移入隔离区）
结论: *** 跨会话污染仍然存在 ***
```

**根因**（`scratch/rootcause.mjs` 精确复现）：
`plan()` 对「目标清单里不存在的路径」（即新建产物）构造候选时，`mine` 被设成 **`[now.size, now.mtime, null]`（当前磁盘状态）**（L606-608），而不是「本会话的目标状态」。而 `foreignTouchedPaths()` 只比较 `theirs[0]!==mine[0] || theirs[1]!==mine[1]`（L550）。别的会话的清单是对**同一 cwd 同一时刻的全量扫描**，`(size,mtime)` 与当前磁盘天然相等 → 判据恒为 false → **新建文件永远不被判 foreign**。

而 CHANGELOG 里那起真实事故，恰恰包含「两个测试文件」（新建）。`tests/fixes.version-and-isolation.mjs` 的隔离用例只测了「B 改一个双方 baseline 里都已存在的文件」（L115/137），**从未测 B 新建文件** → 绿灯放过。

**其余已实测的绕过路径**（`scratch/audit-probe.mjs` / `probe2` / `probe3` / `probe4` / `probe6`）：

| 场景 | 实测结果 |
|---|---|
| B 新建文件 + 已落清单 | `delete` 被 A 执行（P0-1） |
| B 正在改文件、尚未到 `turn/end` 落清单 | B 的改动被 A `restore` 还原成旧内容 |
| B 的 cwd 只是尾斜杠/大小写不同 | `manifest.cwd !== cwd`（L542）把它当无关项目跳过检测 → B 改动被还原 |
| 同 size + 保 mtime 改写（`cp -p` / 编辑器保 mtime） | 清单里有 sha256 却完全没用上，`foreignTouchedPaths` 与 `plan` 的 `changed`（L645）都只看 size+mtime → 漏判 |
| B 的清单 `at <= A 目标 at`（同毫秒 / 时钟回拨 / B 没再落清单 / 清单被 prune） | L540 整份清单被跳过 → 漏判 |
| `sanitizeId` 碰撞（`sess/A` 与 `sess_A` 同为 `sess_A`） | 两会话共享同一目录；L524 按目录名「排除自己」把真正的别人也排除 → 检测完全跳过 |
| 目录混合（A 新建 `out/`，B 往同目录放文件） | `quarantinePath` 整棵目录移动，B 的文件一起被移走 |
| `finishRestore` 后二次回退 | 回退后按「当前磁盘」补写的 marker 清单把 B 的字节吸收成 A 的历史状态；`at` 前移令旧 foreign 证据失效 |

**修复方向**：
- 对「目标清单不存在」的路径单独保守处理：只要无法证明是本会话产物，一律 skip；**绝不能拿当前磁盘状态冒充目标状态**去和别人的清单比。
- 全部身份比较改用**内容 sha256**（清单 `[2]` 已有）：目标 hash vs 别会话 hash；`null` 视作「不可证同」→ 保守判 foreign。`plan` 的 `changed` 也改为 hash 判定。
- 放弃 wall-clock 代理（L540 `manifest.at > since`）：改逻辑时钟 / per-path ownership（记录每个路径最后写入者 sessionId）；至少处理同毫秒、prune 保留、清单缺失。
- `cwd` 用 `path.resolve + fs.realpath` 规范化后比较；缺 `cwd` 的清单按「未知」保守处理。
- `sanitizeId` 改为单射（如 `sanitizeId(id)+'-'+shortHash(id)`），与 `index.js:safeSessionId` 统一；目录内写 `session.json` 记录真实 id。
- **根本方案**：清单不再是「整个工作区全量扫描」，而是按会话记录「本回合本会话实际写过的路径集合」，回退只对齐这个集合。当前「全量扫描 + 事后启发式排除」的结构性缺陷无法靠打补丁根治。

---

## P0-2｜第二套还原引擎 `restoreAfter` 完全绕过跨会话 guard（结构性，最易忽略）

**级别：致命**
**位置**：`lib/index.js` `executeRewind()` L2905-2930、`executeRegenerate()` L3255-3277；`SnapshotStore.planRestore()` L1181-1237、`restoreAfter()` L1263-1318、`applyActionToDisk()` L1496-1526

每次 `mode==='both'` 的回退/regen **串行执行两套独立还原**：
1. `store.restoreAfter(sessionId, targetSeq, (path)=>unlink(path))`（L2909 / L3257）—— checkpoint 侧，按本会话 `write`/`edit` 记录还原，**直接 `unlink` 删除 / `copyFile` 覆盖字节**；
2. `artifactTracker.restore(...)`（L2933 / L3277）—— 全量清单侧，**guard 只加在这里**。

`planRestore()`（L1181）只按本会话 `sessionId` 的 entries 找 `before` 字节，用 `probe.matches(source, entry.path)`（L1212）与当前磁盘比对，不同就 `restore` 写回（L1218-1224）。**它没有任何「这个路径是否被别的会话改过」的判断。**

**场景**：B 用 `write`/`edit` 改了 `shared.txt`（`captureBefore` L2537 会记 B 的 checkpoint），A 的 checkpoint 里也有 `shared.txt`（A 早期改过）。A 执行 `/rewind both` → L2909 先把 A 的旧字节写回，**覆盖 B 的改动**；此后 L2933 的 artifact guard 即使判 foreign skip 也已无意义。

**同源通道**（isolation-auditor S12/S14）：
- `impactsAfter`/`previewImpact`（L2702-2724）：预览合并了 `store.impactsAfter`（L1239，无 guard）与 `artifactTracker.preview`，用户看到的影响清单**不含 checkpoint 侧的真实风险**。
- journal 崩溃补偿 `continueRestore`（L1630）/`rollbackRestore`（L1736）：自动重放，不经 `plan`，不检查别的会话。
- `reconcileTracked`（L2282-2304，在 `user/message` 边界 L3552 触发）：用 `probe.copy(path, staged)` 抓「当前磁盘字节」存成 A 的 checkpoint → 把 B 的字节吸收成 A 的 before 源。
- `finishRestore`（artifact-track.js L879-904）：回退后按当前磁盘补清单，把 checkpoint 写回的旧状态一并吸收。

**修复方向**：把 foreign 判定**上移到 `executeRewind`/`executeRegenerate` 层**，算出 foreign path 集合后同时过滤 `restoreAfter` 的 plan（或给 `planRestore` 传 skip 集）与 journal 补偿；或统一到单一还原通道。这是**优先级最高**的一条 —— 不修它，P0-1 的所有 guard 都可能白做。

---

## P0-3｜SECURITY.md「路径包含性校验」是假的：唯一校验函数是死代码

**级别：致命（任意路径写/移/删出工作区）**
**位置**：`lib/artifact-track.js` `toRel()` L42-46（**全仓从未被调用**，已用 grep 确认）、`fromRel()` L48-50（`join(cwd, ...rel.split('/'))`，**零校验**）；消费点 L106/132/352/424/621/665/695/783-784/850/872/873

SECURITY.md L11 声称「工作区路径全部经过包含性校验：解析后的绝对路径必须落在工作区根目录内，防止 `..` 或符号链接把还原写出工作区」。**这个校验只存在于死代码里。** 清单 JSON 是磁盘上可写、跨进程/跨版本共享的不受信任输入，`loadManifest()`（L212-233）只校验 `v` 和 `files` 是 object，**不校验任何 rel 或 hash**。

**实测**（`scratch/audit-security-poc.mjs`，已跑通）：
- 清单写 `"../OUTSIDE-victim.txt"` → `plan()` 产出 `restore:../OUTSIDE-victim.txt` → `restore()` 经 `copyFile`+`rename` **把内容写到工作区外文件**。
- 越界 rel 指向工作区外已存在目录 → 触发 `restore` L714-728「目标变目录则整棵移入隔离区」→ `quarantinePath` 把它**整棵 `rename` 移走**。
- `../`、`a/../../`、`sub\..\..\`、盘符 `C:/Windows/...`、`/etc/passwd`、UNC `\\server\share\...` 全部无防御。
- 父目录 symlink：`walkWorkspace` 跳过 symlink（L116）而写回不复核父目录 → 写出工作区。
- `blobPath(sessionId, hash)` = `join(blobsDir, hash)`（L283-285）：hash 来自清单 `[2]`，可注入 `../../secret.txt`；`plan` 的 `backupReady` 只用 `exists()`（L637）。
- `cacheContent` 用 `fromRel` 拼的绝对路径 `copyFile`（L294）→ 被投毒的旧清单可把**工作区外文件读进快照明文目录**（信息泄露）。

**附带**：`isJournalPathSafe`（`index.js` L535-550）声称要求路径落在工作区内，但**函数体从不使用 `sessionDir`/`journalSessionId` 参数**，只挡盘符根和少数系统目录名。已实测 `C:\Users\victim\.ssh\id_rsa`、`/etc/shadow` 等全部返回 `safe=true`；配合来自可写 journal 的 `parent` 字段，崩溃恢复时会自动重放越界路径 → **第二个「不受信任输入 → 写/删」入口**。

**修复方向**：新增 `resolveContained(cwd, rel)`（`resolve` + `relative` 包含性 + 逐段 `realpath` 父目录复核），替换所有 `fromRel` 调用；`loadManifest` 增加 schema（rel 白名单、value 为长度 3 数组、hash `/^[0-9a-f]{64}$/`）；`blobPath` 强制 64hex；`isJournalPathSafe` 真正使用 sessionDir 做 relative 校验。

---

## P0-4｜「从不删除文件」不成立：真实 `rm`/`unlink` + 隔离去向可丢

**级别：高（数据丢失）**
**位置**：`quarantinePath` L782-837（L805/807 `rm(abs,...)` 删源）、`collectLeftoverTmp` L873、`pruneManifests` L375、`collectGarbage` L406、`finishRestore` L882；`index.js` L1500 `deleteFile(path)`=`unlink`、L1881/1906/1956-1957/2038/2161

SECURITY.md L19 声称「从不删除文件，一律移入隔离区」。实际是 copy + `rm` 源；且：
- `rename` 已成功（源已移走）后 `index.json` 写失败被 `.catch(() => undefined)` 静默吞掉（L763-771）→ **去向不可追回，无告警、无回滚**。
- `copyFile` 成功但 `rm` 前崩溃 → 源在、dest 是半份副本；`rename` 分支失败时 `copyFile`+`rm` 也可能留下半还原状态。
- `collectGarbage`（L403-407）对 `blobsDir` 里「不在 live 集合」的**任意文件名** `rm`。
- autoCleanup（`index.js` prune L2020-2044）按 `lastActiveMs < cutoffMs` 删**整个会话目录**，含未取回的 quarantine。

**修复方向**：隔离改为「copy 到隔离区 + fsync + 校验 size/hash → unlink 源 → 写 index.json + fsync」，任一步失败不删源且计入 `summary.errors`；index.json 写失败 fail-loud；所有 cleanup/prune/collect 的删除限制在插件命名空间白名单；SECURITY.md 措辞改为「源在隔离副本校验成功后被移除」。

---

## P0-5｜版本切换只是改显示，不碰模型上下文 →「看到的对话 ≠ 模型实际上下文」长期错位

**级别：致命（用户基于错误上下文继续提问）**
**位置**：`lib/client.js` L1051-1066（`selectedVersion` 注释自认「仅影响显示，不影响模型上下文」）、L943-951、L2355-2357、L1160；`isAnchorVisibleInCut` L1287-1297、`isOriginalVersionSelected` L1309-1313

版本切换是**纯前端 visibility 切换**（`setSelectedVersion` L1060-1066 只调 `inner.replace`），不触发宿主命令、不改模型上下文。用户切回第 1 版（原始回答）后屏幕上显示旧答案，但模型仍基于**最新上下文**回答。`refreshCuts` 只在 cuts 变化时复位 → 屏幕停在旧版、上下文已前进，长期错位。CHANGELOG any.11 把「原始版可真正切回」当作修复，实际引入了这一类风险。

**修复方向**：要么切版本时显式提示「当前显示历史版本，继续提问将基于最新版本上下文」，要么把切版本做成真正的宿主 rewind/fork（改模型上下文），二选一，不能含糊。

---

## P0-6｜几何区间归属判据反例：原始版无条件放行、targetSeq/markerSeq 混用同一数轴

**级别：致命（版本控件乱显/漏显）**
**位置**：`lib/client.js` L2411-2415

`if (v.original === true) return true` **无条件放行** → 任何一条助手回答都把全部原始版算进本组；`lo=endSeq+1 / hi=下一markerSeq-1` 把「重发提示 seq(targetSeq)」与「markerSeq」当同一数轴，多个相邻/相等/乱序 marker 或 `targetSeq === markerSeq` 时区间错配。CHANGELOG any.16 声称「归属判据改为几何区间」修好了，但边界条件仍无测试覆盖。

**关联 P1**：`selectedVersion` 是**每会话一个全局单值**（L943-951），而 `annotateVersionCuts`（L1241-1261）按 target 分组各自编 1..N 版 → 选第 2 版会把所有提示词组一起按各自 total 夹取显示，**跨提示词版本串台**；叠加「回退→regen→回退」时不同 target 的 cut 命中首个即 return（L1211-1215），嵌套区间未再检查。

---

## P0-7｜测试套件结构性地不可能发现这类 bug

**级别：致命（质量保障失效）**
**位置**：`tests/` 全部 15 个文件、`scripts/verify.mjs`、`package.json`（无 `test` script / 无 CI）

实测事实（test-auditor 逐个实跑）：
- **肇事的 `executeRewind → restore → plan → foreignTouchedPaths` 链路，零测试覆盖**。全仓只有 `tests/regen.command.mjs` import 了 `lib/index.js` 并执行 `apply()`，且**只调用 `/regen` handler**，从不碰 `/rewind`/`executeRewind`/`planRewind`。
- `tests/fixes.version-and-isolation.mjs` 的 `buildVersions()`（L24-66）是**把宿主 versions 端点算法整段抄进测试再断言这份副本**（同义反复）。宿主实现改坏、副本没跟着改 → 副本仍绿。`regen.e2e.mjs` 里还有第二份用**旧模型**的镜像，两份互相矛盾却各自通过。
- 6 个测试用 `new Function(grab(...))` 抽取源码片段求值，连模块实例都没有；`regen.preview-error.mjs` 有 5 项是 `src.includes(...)` **字符串断言**。
- 跨会话隔离测试是「顺境 fixture」：只测 B 改**已存在**文件、人为 `setTimeout(20)` 错开 `at`、size 必变、`keepManifests=50` 不裁剪、只回退一次 —— 恰好是 guard 唯一能工作的交集。事故里的「B 新建文件」「B 自己回退删证」「清单被裁剪」「回退后再回退」「同 size/mtime」「cwd 别名」全在交集外。
- **`regen.versions.mjs` 本次实跑直接 exit 1**（硬编码本机会话日志 `ENOENT`）；`audit-probe.mjs` 零断言且永远 exit 0；`regen.version-ownership.mjs` 有 5 项在日志缺失时静默 skip。**CHANGELOG「13 个文件 270 项断言全部通过」与实跑不符**（14 个自检文件合计 240 项，其中含崩溃与零断言文件）。
- `scripts/verify.mjs` 只做 6 项静态指纹/哈希检查，**完全不跑任何 `tests/*.mjs`**；仓库无 test runner、无 CI、无 `test` script。
- `verify.mjs` 的 3 个期望 sha256 是**硬编码常量**，从不读 `dist/*.tgz`；已解包核对本次 any.18 恰好与 `lib/` 一致，但这是巧合不是保障。

**病根一句话**：不是审计轮数不够，是**每一轮都在用同一种方法** —— 对着自己抄的算法断言、对着顺境 fixture 断言、对着源码字符串断言。这种套件的绿灯只覆盖「作者已经想到的正确路径」，对「作者没想到的组合」结构上免疫。跨会话污染是**组合/状态机**问题，必然落在盲区里。

**修复方向**（test-auditor S0-S9）：
1. 先补统一 test runner（`package.json` 加 `test` script，任一文件 exit≠0 即整体失败），把崩溃/零断言/静默 skip 文件修掉。
2. **把「真实事故形状」作为合并红线**：断言「A 的回退绝不能改变任何不属于 A 的文件」，先让它在当前实现上**变红**，再修实现。
3. 禁止镜像实现；隔离测试一律 import 真实 `ArtifactTracker`，端到端再 import `lib/index.js` 并走 `apply()` 的 `/rewind` handler。
4. 加不变式/属性测试：固定种子组合生成 A/B 的写文件序列、清单裁剪、回退次数、mtime 保留、cwd 别名，每次 A 回退后遍历 B 的 `(path→bytes)` 快照断言全等。
5. 补 dist/ 与 lib/ 的自动一致性校验，期望摘要从 lib/ 实时计算。

---

## P1 高（9 项，摘要）

| # | 级别 | 位置 | 问题 |
|---|---|---|---|
| 1 | 高 | `artifact-track.js` L288-355 | `cacheContent` 从共享 cwd `copyFile` 抓字节，跨会话并发时 blob 归属错乱，`restore` 会把别人的内容写回；`enqueue`（L189-196）只串行化同一 sessionId，跨会话无锁 |
| 2 | 高 | `artifact-track.js` L611-617 + 内部 L517-537 | `foreignTouchedPaths` 多处静默 `catch` 返回空集，异常根本到不了 fallback；fallback 谎报 `coverage:"ok"`、把「检测失败」标成 `foreign-session`，用户只看到「N 个无备份」 |
| 3 | 高 | `artifact-track.js` L661-667 / L681 | `preview()` 与 `restore()` **各调一次独立 `plan()`**，中间的 B 落清单/改文件造成 TOCTOU；用户确认的影响清单 ≠ 实际执行；`restore` 循环中途无 re-check |
| 4 | 高 | `artifact-track.js` L782-837 | foreign 是 per-file 精确 rel，但 `quarantinePath` 整棵目录 `rename`；目录混合场景连带移走别人的文件（已实测） |
| 5 | 高 | `client.js` L226-251 vs `index.js` L2648-2665 | 客户端把任意 `name==='regen' && success` 命令算遮蔽区间，宿主 versions 只认 command/run+done 配对 marker；`/regen v<N>`、失败/外部 regen 让隐藏段数与版本控件数不一致 |
| 6 | 高 | `client.js` L882/679/1789-1803 | preview 在弹窗打开时算一次、确认时 `executeRewind` 重算 plan，8s 超时后无一致性校验 → 影响清单陈旧；错误码映射只覆盖 3 类，宿主 `session-not-found`/`bad-request`/`agents-unavailable`/`failed` 直接露英文 |
| 7 | 高 | `index.js` L1997-2046 / 2156-2166 / 2265-2277 / 3098-3119 | `pruneStale`/`clearSession`/`reconcileFormatVersion` 会删掉共享 `store.root` 下别的会话的清单证据与 quarantine（artifact 与 checkpoint 目录同根同级） |
| 8 | 高 | `index.js` L1630 / 1736 | journal 崩溃补偿 `continueRestore`/`rollbackRestore` 自动重放，不经 `plan`、不检查别的会话（S5 的延迟延伸） |
| 9 | 高 | `index.js` L2282-2304 | `reconcileTracked` 在边界抓「当前磁盘」当本会话 checkpoint，把 B 的字节吸收成 A 的 before 源 |

---

## P2 中（8 项，摘要）

- **ID 清洗非单射**：`sanitizeId`（`artifact-track.js` L38-40）与 `safeSessionId`（`index.js` L450-453）规则不一致；`sess/A` 与 `sess_A` 共享目录；sessionId 为 `..` 时 `dirOf` 逃出快照根。
- **原型链查找**：`rel in target.files`（L590）对 `constructor`/`toString` 等原型属性返回 true；`JSON.parse` 的 `__proto__` 是自有键非污染，但可能误判 changed 并生成危险 action。用 `Object.hasOwn` 替代。
- **DoS**：`walkWorkspace` 无深度/数量/字节上限；清单 JSON 无大小上限；`foreignTouchedPaths` 全量遍历其它会话；`restore` 逐文件全量 sha256；无 signal/超时，与「8s 内返回」注释不符。
- **regen 预快照误导**：`recordSnapshotForRegenerate`（L449-473）hash 恒 null、不参与 foreign 判定、也不驱动还原，只是提示文字，却给了「版本可追溯」的错误安全感；且无 cwdHint 兜底，注册竞态时静默跳过。
- **selectedVersion 全局单值 + 分组编号**：跨提示词版本串台（见 P0-6 关联）。
- **`liveBuilders` 按 sessionId 从不清理**：HMR/重连/切会话残留；多次快点击与 RPC 乱序无请求序号防护。
- **敏感数据**：快照明文落 `~/.dsh/rewind-snapshots/`；autoCleanup 以 mtime 而非「是否有未取回隔离内容/未完成 journal」为判据，可能误删。
- **`bareRegenTargetOf` 镜像宿主 `latestUserSeqOf`**（`client.js` L257-269）：又一处镜像漂移风险，宿主改了测试副本不跟着改。

---

## 修复优先级（建议执行顺序）

1. **P0-2**：把 foreign 判定上移到 `executeRewind`/`executeRegenerate`，同时过滤 `restoreAfter`、journal 补偿、`reconcileTracked`。**不修这条，其余 guard 都可能白做。**
2. **P0-1**：重构清单为「按会话记录本回合实际写过的路径」，或至少：新建文件单独保守处理、全部比较改用 sha256、放弃 wall-clock 代理、cwd 规范化、ID 单射。
3. **P0-3 / P0-4**：`resolveContained` 替换所有 `fromRel`；`loadManifest` schema；隔离改为可校验的原子流程；`isJournalPathSafe` 真正做包含性校验；修正 SECURITY.md 措辞。
4. **P0-7**：补 test runner + 真实事故回归红线（先红后绿）+ 不变式测试 + 端到端 `/rewind` + dist 校验。**这一步决定了下一次「严格审计」还会不会漏。**
5. **P0-5 / P0-6**：版本切换要么明确提示「显示历史版、上下文是最新版」，要么做成真正改上下文的宿主操作；修几何区间边界与全局 selectedVersion。
6. 再按 P1/P2 逐项收敛。

---

## 证据文件索引（均在 `scratch/`，未改 lib/tests）

| 文件 | 证明 |
|---|---|
| `repro-cross-session-pollution.mjs` | P0-1 权威复现（CHANGELOG 事故形状） |
| `rootcause.mjs` | P0-1 精确根因（新建文件 mine 取自 now） |
| `audit-probe.mjs` / `probe2` / `probe3` / `probe4` / `probe6` | 新建文件、未落清单、cwd 别名、同 size/mtime、目录隔离、finishRestore 吸收、缓存串会话、ID 碰撞 |
| `audit-probe5.mjs` | `fromRel` 零校验、blobPath 注入、原型链 |
| `audit-security-poc.mjs` | P0-3 实测写出/移走工作区外文件 |
| `audit-journal-check.mjs` | `isJournalPathSafe` 对 5 个越界路径全部返回 safe |
| `isolation-probe*.mjs` / `.out` / `run-all.*` | test-auditor 的隔离缺口与全量测试实跑结果 |
| `tests/fixes.version-and-isolation.mjs` L109-162 | 「已修复」测试的覆盖范围（反而证明盲区） |

> 注：本次审计**只读** `lib/` 与 `tests/`，未修改任何产品代码或测试文件；`scratch/` 下的探针为新增诊断脚本。发布包 `dist/dsh-any-rollback-0.19.1-any.18.tgz` 已解包核对，三个 `lib/*.js` 与仓库源码 sha256 完全一致，因此以上缺陷**全部存在于已发布版本**。
