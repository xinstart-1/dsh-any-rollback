# 更新日志

## [0.19.1-rb.1] - 2026-11-02

`dsh-rollback`：在上游 `dsh-rewind-plugin@0.19.1` 基础上加上「命令产物追踪」补丁的重打包版，
供 DSH harness **0.2.1 线**使用（上游 0.20.0-alpha.1 要求 DSH `>=0.2.2-alpha.2`，在 0.2.1 线上加载即被拒）。

### 新增

- `lib/artifact-track.js` —— 回合边界的工作区清单（`路径 → size + mtime + sha256`）、
  只对**发生变化**的文件按摘要缓存内容，以及一个隔离区，用于承接回退时必须离开工作区的文件
  （`manifests/`、`quarantine/`、`quarantine/index.json`，位于 `<snapshotDir>/<sessionId>/artifacts/` 下）。
- 5 个插件配置项：`artifactTrackingEnabled`、`artifactMaxFileBytes`、`artifactBaselineContent`、
  `artifactExclude`、`artifactKeepManifests`。

### 变更

- `lib/index.js` 打补丁（10 个 hunk）：`ArtifactTracker` 导入、配置结构、`turn/end` 采集、
  `previewImpact` 合并、`executeRewind` 的还原/隔离接线、`apply()` 初始化。
- 包名改为 `dsh-rollback`，以便与 npm 上的上游包并存。改名同步到了 DSH 依赖的**四处身份**：
  `package.json` 的 `name`、`cordis.patch.yml` 的加载器行（`id` + `name`）、
  客户端 bundle 里 `__ModuleLoader__.load({ id })` 的注册 id，以及编译后的
  `PLUGIN_PACKAGE` / `SETTINGS_ENTRY_ID` 常量。
- `package.json`：去掉 `scripts.prepare`，避免安装 tarball 时尝试跑一个没有随包发布的构建。

### 说明

- **内部标识**刻意保留上游名字，旧数据继续可读：会话标记类型 `dsh-rewind`、快照目录 `rewind-snapshots`、
  RPC 频道 `/dsh-rewind`、CSS 类名前缀 `dsh-rewind-`。
- 改名会丢掉旧的设置文档（DSH 按 entry id 存配置）。到插件页把备份开关和清理策略重设一次即可；
  已存的快照本身不受影响。
- 补丁打在**构建产物**层，上游源码里没有它。从 npm registry 装上游包拿回的是没有补丁的版本 ——
  请用本仓库的 tarball 重装，或对已装的 `dsh-rollback` 目录跑 `scripts/refresh.ps1` 重新同步。
- 上游把这个追踪边界当作有意的设计取舍（`docs/compat/tracking-boundary.md`，Limitation 1），
  因此本补丁属于本地绕行方案，不预期会被上游采纳。
