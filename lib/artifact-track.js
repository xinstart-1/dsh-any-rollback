// dsh-any-rollback · 命令产物追踪（边界清单 + 内容缓存 + 隔离区回滚）
//
// 常规的检查点方案只追踪 write/edit 两个写类工具动过的文件
// （TRACKED_TOOLS = {write, edit}），并且单文件上限默认 8MB。渲染脚本
// （node render.mjs / ffmpeg）产出的 MP4 既不经过 write/edit、又远大于 8MB，
// 因此回退时完全不会被动到。
//
// 本模块在“回合边界”对工作区做一份轻量清单（路径 → size + mtime + 内容哈希），
// 只对“跟上一次清单相比变了”的文件做内容缓存（内容寻址、按 sha256 去重）。
// 回退到某个目标消息时：
//   - 目标时刻存在、现在不同 / 缺失，且有内容备份 → 还原字节；
//   - 目标时刻不存在、现在存在（命令新建的产物，或旧内容没备份的大文件）→ 移入隔离区；
//   - 无备份内容的大文件（例如插件启用前就存在的成片）→ 移入隔离区并计入 skipped，
//     由用户重新渲染得到目标版本。
// 隔离区保留原始字节，`index.json` 记录每一份的去向，可人工取回。

import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const MANIFEST_VERSION = 1;
// Only dependency/build directories that nobody rewinds. Dot-directories are
// NOT excluded by default: tooling often writes real artifacts into them.
const DEFAULT_EXCLUDE =
  'node_modules,dist,build,out,coverage,__pycache__,venv,.venv,target';

function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function toRel(cwd, abs) {
  const rel = relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function fromRel(cwd, rel) {
  return join(cwd, ...rel.split('/'));
}

function parseExclude(raw) {
  const names = new Set();
  for (const part of String(raw ?? DEFAULT_EXCLUDE).split(',')) {
    const name = part.trim().toLowerCase();
    if (name !== '') names.add(name);
  }
  return names;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/**
 * Directories skipped unconditionally, on top of the user's `artifactExclude`.
 * These are VCS / tooling state that no rewind should touch, and they can hold
 * hundreds of thousands of files.
 */
const ALWAYS_SKIP = new Set(['.git', '.hg', '.svn', '.dsh', '.dsh-file-attachment']);

/** 递归扫描工作区：relPath -> { size, mtime }（跳过符号链接、基础设施点目录与排除目录名）。 */
async function walkWorkspace(cwd, exclude) {
  const files = new Map();
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? cwd : fromRel(cwd, relDir);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of entries) {
      const name = dirent.name;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        // Dot-directories are tracked: plenty of tooling writes real artifacts
        // into `.output/`, `.cache/` and friends, and skipping every dot-prefixed
        // directory silently excluded them. Only infrastructure state is skipped.
        const lower = name.toLowerCase();
        if (ALWAYS_SKIP.has(lower) || exclude.has(lower)) continue;
        stack.push(rel);
        continue;
      }
      if (!dirent.isFile()) continue;
      // 还原流程自己的临时文件不是产物：一旦收进清单，下次回退会把它们
      // 当成"新建产物"移进隔离区（真实发生过）。
      if (/\.rewind-\d+\.tmp$/.test(name)) continue;
      let info;
      try {
        info = await stat(fromRel(cwd, rel));
      } catch {
        continue;
      }
      files.set(rel, { size: info.size, mtime: Math.round(info.mtimeMs) });
    }
  }
  return files;
}

export class ArtifactTracker {
  /**
   * @param {object} opts
   * @param {() => string} opts.rootDir 快照根目录（插件 store.root）
   * @param {(sessionId: string) => string | undefined} opts.cwdOf 会话工作区
   * @param {number} [opts.maxFileBytes] 单文件内容缓存上限
   * @param {boolean} [opts.baselineContent] 基线也缓存内容
   * @param {string} [opts.exclude] 逗号分隔的排除目录名
   * @param {number} [opts.keepManifests] 每会话保留的清单份数
   * @param {{warn?: Function, info?: Function}} [opts.logger]
   */
  constructor(opts) {
    this.rootOf = opts.rootDir;
    this.cwdOf = opts.cwdOf;
    this.maxFileBytes = Number.isFinite(opts.maxFileBytes) ? opts.maxFileBytes : 64 * 1024 * 1024;
    this.baselineContent = opts.baselineContent === true;
    this.exclude = parseExclude(opts.exclude);
    this.keep = Number.isFinite(opts.keepManifests) ? Math.max(1, opts.keepManifests) : 200;
    this.logger = opts.logger;
    this.queues = new Map();
  }

  dirOf(sessionId) {
    return join(this.rootOf(), sanitizeId(sessionId), 'artifacts');
  }

  manifestsDir(sessionId) {
    return join(this.dirOf(sessionId), 'manifests');
  }

  blobsDir(sessionId) {
    return join(this.dirOf(sessionId), 'blobs');
  }

  quarantineDir(sessionId) {
    return join(this.dirOf(sessionId), 'quarantine');
  }

  manifestPath(sessionId, key) {
    return join(this.manifestsDir(sessionId), `${String(key).padStart(12, '0')}.json`);
  }

  warn(message) {
    this.logger?.warn?.(`[dsh-rewind-artifacts] ${message}`);
  }

  /** 每会话串行化，避免两次扫描互相覆盖清单。 */
  enqueue(sessionId, task) {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task).catch((error) => {
      this.warn(`task failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(sessionId, next);
    return next;
  }

  async listManifestKeys(sessionId) {
    let names;
    try {
      names = await readdir(this.manifestsDir(sessionId));
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.slice(0, -5)))
      .filter((key) => Number.isSafeInteger(key))
      .sort((a, b) => a - b);
  }

  async loadManifest(sessionId, key) {
    let raw
    try {
      raw = await readFile(this.manifestPath(sessionId, key), 'utf8')
    } catch {
      return undefined; // 文件不存在：正常
    }
    try {
      const data = JSON.parse(raw);
      if (!data || data.v !== MANIFEST_VERSION || typeof data.files !== 'object') {
        this.warn(`manifest ${sessionId}/${key} has an unrecognized shape; it will be ignored`);
        return undefined;
      }
      return data;
    } catch (error) {
      // 清单损坏意味着这个时间点再也还原不了，绝不能静默退化成"无动作"。
      this.warn(
        `manifest ${sessionId}/${key} is corrupt and was ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** 目标消息对应的状态：最后一份 key 严格小于 targetSeq 的清单，否则基线（key 0）。 */
  async stateAt(sessionId, targetSeq) {
    const keys = await this.listManifestKeys(sessionId);
    let picked;
    for (const key of keys) {
      if (key < targetSeq) picked = key;
    }
    if (picked === undefined) {
      if (keys.length > 0 && keys[0] === 0) return this.loadManifest(sessionId, 0);
      return undefined;
    }
    return this.loadManifest(sessionId, picked);
  }

  async blobPath(sessionId, hash) {
    return join(this.blobsDir(sessionId), hash);
  }

  /** 把文件内容写进内容寻址缓存；超过上限或读不到则返回 null。 */
  async cacheContent(sessionId, absPath, size) {
    if (!Number.isFinite(this.maxFileBytes) || this.maxFileBytes <= 0) return null;
    if (size > this.maxFileBytes) return null;
    const tmp = join(this.blobsDir(sessionId), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(this.blobsDir(sessionId), { recursive: true });
    try {
      await copyFile(absPath, tmp);
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
    let hash;
    try {
      hash = await sha256File(tmp);
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
    const dest = join(this.blobsDir(sessionId), hash);
    if (await exists(dest)) {
      await rm(tmp, { force: true });
      return hash;
    }
    try {
      await rename(tmp, dest);
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
    return hash;
  }

  /**
   * 记录一次边界状态。keySeq = 该回合起始的用户消息 seq
   * （清单语义是“这一回合跑完之后的工作区状态”）。
   */
  async record(sessionId, keySeq) {
    const cwd = this.cwdOf(sessionId);
    if (cwd === undefined) {
      this.warn(`no workspace directory for ${sessionId}; artifact tracking skipped`);
      return undefined;
    }
    const keys = await this.listManifestKeys(sessionId);
    const prevKey = [...keys].reverse().find((key) => key <= keySeq);
    const prev = prevKey === undefined ? undefined : await this.loadManifest(sessionId, prevKey);
    const current = await walkWorkspace(cwd, this.exclude);
    const files = {};
    let cached = 0;
    for (const [rel, info] of current) {
      const before = prev?.files?.[rel];
      // Reuse the previous digest only when mtime is *identical*, not merely
      // close. The old tolerance window (1500 ms) silently kept a stale digest
      // for a same-size rewrite that happened right after the previous boundary,
      // so a rewind would restore content older than the target state.
      if (before && before[0] === info.size && before[1] === info.mtime) {
        files[rel] = [info.size, info.mtime, before[2] ?? null];
        continue;
      }
      const hash = await this.cacheContent(sessionId, fromRel(cwd, rel), info.size);
      if (hash !== null) cached++;
      files[rel] = [info.size, info.mtime, hash];
    }
    const data = {
      v: MANIFEST_VERSION,
      key: keySeq,
      at: Date.now(),
      cwd,
      files,
    };
    await writeJsonAtomic(this.manifestPath(sessionId, keySeq), data);
    await this.pruneManifests(sessionId, keySeq);
    return { key: keySeq, files: current.size, cached };
  }

  async pruneManifests(sessionId, keepFromKey) {
    const keys = await this.listManifestKeys(sessionId);
    const keep = new Set(keys.slice(-this.keep));
    keep.add(keepFromKey);
    for (const key of keys) {
      if (keep.has(key)) continue;
      if (key === 0) continue; // 基线永远保留
      await rm(this.manifestPath(sessionId, key), { force: true }).catch(() => undefined);
    }
    // Pruning manifests makes the digests they referenced unreachable; collect
    // the orphaned blobs in the same pass so the cache cannot grow forever.
    await this.collectGarbage(sessionId);
  }

  /**
   * 回收不再被任何清单引用的内容缓存。
   * 清单保留是有上限的，被裁掉的清单引用的 blob 已无法再被还原使用，
   * 留着只会让 artifacts/blobs 无限增长。
   */
  async collectGarbage(sessionId) {
    let names;
    try {
      names = await readdir(this.blobsDir(sessionId));
    } catch {
      return { removed: 0, kept: 0 };
    }
    const live = new Set();
    for (const key of await this.listManifestKeys(sessionId)) {
      const manifest = await this.loadManifest(sessionId, key);
      for (const entry of Object.values(manifest?.files ?? {})) {
        const hash = entry?.[2];
        if (typeof hash === 'string' && hash !== '') live.add(hash);
      }
    }
    let removed = 0;
    for (const name of names) {
      if (live.has(name)) continue;
      // 临时文件（写入中途崩溃留下的）也一并清掉
      await rm(join(this.blobsDir(sessionId), name), { force: true }).catch(() => undefined);
      if (!name.startsWith('.tmp-')) removed++;
    }
    return { removed, kept: live.size };
  }

  /** 会话刚建立时的基线（key 0）：只记录存在性，默认不缓存内容。 */
  async ensureBaseline(sessionId) {
    const keys = await this.listManifestKeys(sessionId);
    if (keys.includes(0)) return;
    return this.enqueue(sessionId, async () => {
      const cwd = this.cwdOf(sessionId);
      if (cwd === undefined) return;
      const current = await walkWorkspace(cwd, this.exclude);
      const files = {};
      for (const [rel, info] of current) {
        let hash = null;
        if (this.baselineContent) {
          hash = await this.cacheContent(sessionId, fromRel(cwd, rel), info.size);
        }
        files[rel] = [info.size, info.mtime, hash];
      }
      await writeJsonAtomic(this.manifestPath(sessionId, 0), {
        v: MANIFEST_VERSION,
        key: 0,
        at: Date.now(),
        cwd,
        files,
      });
    });
  }

  /** 回合结束时记一份清单。 */
  async onTurnEnd(sessionId, keySeq) {
    return this.enqueue(sessionId, () => this.record(sessionId, keySeq));
  }

  /**
   * 重新生成前的产物预快照：把当前工作区状态记成一份带负数 key 的清单，
   * 与正常边界清单走同一存储与回收机制。返回给回退结果的一段提示文字
   * （列出本轮有多少产物会被重新生成的影响面覆盖），无产物时返回空串。
   * @returns {Promise<string>} 提示文字，如 "（产物预快照 12 个文件：版本可追溯）"
   */
  async recordSnapshotForRegenerate(sessionId, targetSeq) {
    const cwd = this.cwdOf(sessionId);
    if (cwd === undefined) return '';
    return this.enqueue(sessionId, async () => {
      // 独立命名空间：负数 key 会被 `String(n).padStart(12,'0')` 写成
      // "0000000-1000"，`Number()` 解析成 NaN 并被 listManifestKeys 过滤 ——
      // 预快照将永远读不到、也永远删不掉。改用 snapshots/ 子目录 + 时间戳。
      const dir = join(this.dirOf(sessionId), 'snapshots');
      await mkdir(dir, { recursive: true });
      const current = await walkWorkspace(cwd, this.exclude);
      const files = {};
      for (const [rel, info] of current) {
        files[rel] = [info.size, info.mtime, null];
      }
      await writeJsonAtomic(join(dir, `regen-${Date.now().toString(36)}.json`), {
        v: MANIFEST_VERSION,
        at: Date.now(),
        targetSeq,
        cwd,
        files,
      });
      const count = current.size;
      return count > 0 ? `产物预快照 ${count} 个文件` : '';
    });
  }

  /**
   * 校验内容寻址 blob 是否与它的文件名（sha256）一致。
   * blob 可能被外部截断或半写；不复核就 copyFile 回去，用户会拿到一个
   * "还原成功"但内容残缺的文件 —— 静默数据损坏，必须拦住。
   * @returns {Promise<boolean>} 一致才 true。
   */
  async blobIsIntact(sessionId, hash) {
    const blob = await this.blobPath(sessionId, hash);
    let actual;
    try {
      actual = await sha256File(blob);
    } catch {
      return false;
    }
    if (actual === hash) return true;
    this.warn(`blob ${hash.slice(0, 12)} is corrupt (digest ${actual.slice(0, 12)}); not restored`);
    return false;
  }

  /**
   * 计划一次回退：目标状态 vs 当前磁盘。
   * 只做 stat，不做哈希，保证界面的影响清单能在 8s 超时内返回。
   */
  async plan(sessionId, targetSeq) {
    const cwd = this.cwdOf(sessionId);
    if (cwd === undefined) return { actions: [], skipped: [], cwd: undefined };
    const target = await this.stateAt(sessionId, targetSeq);
    if (target === undefined) return { actions: [], skipped: [], cwd };
    const current = await walkWorkspace(cwd, this.exclude);
    const actions = [];
    const skipped = [];
    const rels = new Set([...Object.keys(target.files), ...current.keys()]);
    for (const rel of rels) {
      const before = target.files[rel];
      const now = current.get(rel);
      const abs = fromRel(cwd, rel);
      if (before === undefined) {
        if (now !== undefined) actions.push({ rel, action: 'delete', reason: 'created' });
        continue;
      }
      const hash = before[2] ?? null;
      const backupReady = hash !== null && (await exists(await this.blobPath(sessionId, hash)));
      if (now === undefined) {
        if (backupReady) actions.push({ rel, action: 'restore', hash });
        else skipped.push({ rel, reason: 'missing-no-backup' });
        continue;
      }
      // Exact mtime comparison: a tolerance here would report "unchanged" for a
      // same-size rewrite made right after the boundary was recorded.
      const changed = now.size !== before[0] || now.mtime !== before[1];
      if (!changed) continue;
      if (backupReady) {
        actions.push({ rel, action: 'restore', hash });
      } else {
        // The file EXISTED at the target state, but its content was never cached
        // (over the cap, or unreadable). We cannot know what it held then, so we
        // must not move it: that would make a file the user still has disappear
        // from the worktree. Leave it in place and report it as skipped instead.
        skipped.push({ rel, reason: 'changed-no-backup' });
      }
    }
    return { actions, skipped, cwd };
  }

  /** 供 popover 的影响清单使用：{ path, action }[]。 */
  async preview(sessionId, targetSeq) {
    const { actions, cwd } = await this.plan(sessionId, targetSeq);
    if (cwd === undefined) return [];
    return actions
      .map((item) => ({ path: fromRel(cwd, item.rel), action: item.action === 'restore' ? 'restore' : 'delete' }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 执行回退：能还原的还原字节，不能还原的移入隔离区（不硬删）。 */
  async restore(sessionId, targetSeq, markerSeq) {
    const summary = {
      restored: 0,
      quarantine: 0,
      skipped: 0,
      failed: 0,
      dir: undefined,
      errors: [],
      restoredPaths: [],
      quarantinedPaths: [],
    };
    const { actions, skipped, cwd } = await this.plan(sessionId, targetSeq);
    summary.skipped = skipped.length;
    if (cwd === undefined || actions.length === 0) {
      if (cwd !== undefined) await this.finishRestore(sessionId, targetSeq, markerSeq, cwd);
      return summary;
    }
    const opId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const qRoot = join(this.quarantineDir(sessionId), opId);
    summary.dir = qRoot;
    const index = [];
    // 还原前先创建隔离区：任何失败路径都不该让"被移出的内容"没有去处
    await mkdir(qRoot, { recursive: true }).catch(() => undefined);
    for (const item of actions) {
      const abs = fromRel(cwd, item.rel);
      try {
        const info = await lstat(abs).catch(() => undefined);
        if (item.action === 'restore') {
          const blob = await this.blobPath(sessionId, item.hash);
          if (!(await exists(blob))) {
            summary.skipped++;
            continue;
          }
          // 内容必须与内容寻址的文件名一致：损坏/被截断的 blob 一旦写回，
          // 用户会看到"还原成功"却拿到残缺文件。宁可计入 failed 也不写坏数据。
          if (!(await this.blobIsIntact(sessionId, item.hash))) {
            summary.failed++;
            summary.errors.push(`${item.rel}: backup content is corrupt, not restored`);
            continue;
          }
          const current = await lstat(abs).catch(() => undefined);
          // 目标位置已变成目录（或任何非普通文件）时，不能直接覆盖：
          // 先把整个目录递归移入隔离区（保数据），再写文件。
          if (current !== undefined && !current.isFile()) {
            if (current.isSymbolicLink()) {
              summary.skipped++;
              continue;
            }
            const moved = await this.quarantinePath(sessionId, opId, cwd, item.rel, current);
            if (moved === undefined) {
              summary.failed++;
              summary.errors.push(`${item.rel}: target is a directory and it could not be quarantined`);
              continue;
            }
            summary.quarantine += moved.count;
            summary.quarantinedPaths.push(...moved.paths);
            index.push(...moved.index);
          }
          await mkdir(dirname(abs), { recursive: true });
          const tmp = `${abs}.rewind-${process.pid}.tmp`;
          try {
            await copyFile(blob, tmp);
            await rename(tmp, abs);
          } catch (error) {
            // rename 失败时 tmp 残留会随下一次还原被清理；这里先尽力删掉
            await rm(tmp, { force: true }).catch(() => undefined);
            throw error;
          }
          summary.restored++;
          summary.restoredPaths.push(abs);
          index.push({ path: abs, action: 'restore', blob: item.hash });
          continue;
        }
        if (info === undefined) continue; // 已经不在了：目标状态已达成
        if (info.isSymbolicLink()) {
          summary.skipped++;
          continue;
        }
        const moved = await this.quarantinePath(sessionId, opId, cwd, item.rel, info);
        if (moved === undefined) {
          summary.failed++;
          summary.errors.push(`${item.rel}: could not be quarantined`);
          continue;
        }
        summary.quarantine += moved.count;
        summary.quarantinedPaths.push(...moved.paths);
        index.push(...moved.index);
      } catch (error) {
        summary.failed++;
        summary.errors.push(`${item.rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (index.length > 0) {
      await writeJsonAtomic(join(qRoot, 'index.json'), {
        sessionId,
        targetSeq,
        markerSeq,
        at: Date.now(),
        items: index,
      }).catch(() => undefined);
    }
    await this.collectLeftoverTmp(sessionId, cwd);
    await this.finishRestore(sessionId, targetSeq, markerSeq, cwd);
    return summary;
  }

  /**
   * 把一个路径（文件或整棵目录树）移入本次还原的隔离区。
   * 返回 { count, paths, index }；无法安全移动时返回 undefined（调用方计 failed）。
   * 目录会被**整棵移动**，而不是逐个文件隔离 —— 避免出现"目录被移走一半"的中间状态。
   */
  async quarantinePath(sessionId, opId, cwd, rel, info) {
    const abs = fromRel(cwd, rel);
    const dest = join(this.quarantineDir(sessionId), opId, ...rel.split('/'));
    const paths = [];
    const index = [];
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(abs, dest);
    } catch {
      // 跨设备或占用时的兜底：复制后删除。删除失败则整体失败，
      // 决不能出现"复制成功但源没删掉"的半还原状态——那样会重复计数。
      try {
        await copyFile(abs, dest);
      } catch (error) {
        this.warn(`quarantine copy failed for ${rel}: ${error instanceof Error ? error.message : String(error)}`);
        await rm(dest, { force: true, recursive: true }).catch(() => undefined);
        return undefined;
      }
    }
    // 只对文件删除源；目录用 rm 递归删（rename 已整体移走时这一步不存在）
    const stillThere = await lstat(abs).catch(() => undefined);
    if (stillThere !== undefined) {
      if (info?.isDirectory?.()) {
        await rm(abs, { recursive: true, force: true });
      } else {
        await rm(abs, { force: true });
      }
    }
    if (info?.isDirectory?.()) {
      // 逐个记录目录内的文件，便于用户从 index.json 找回
      const walk = async (dir, relBase) => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const childAbs = join(dir, entry.name);
          const childRel = `${relBase}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(childAbs, childRel);
          } else if (entry.isFile()) {
            const size = (await stat(childAbs).catch(() => undefined))?.size ?? 0;
            paths.push(childAbs);
            index.push({
              path: childAbs,
              action: 'quarantine',
              movedTo: join(dest, ...childRel.split('/')),
              reason: 'replaced-by-restore',
              size,
            });
          }
        }
      };
      await walk(dest, rel);
    } else {
      paths.push(abs);
      index.push({ path: abs, action: 'quarantine', movedTo: dest, reason: 'created', size: info?.size ?? 0 });
    }
    return { count: paths.length, paths, index };
  }

  /**
   * 清理上次还原失败遗留的 *.rewind-<opId>.tmp 临时文件。
   * 只认本次进程写入的、带自己 pid 且形如 `<name>.rewind-<pid>.tmp` 的文件，
   * 并且要求同目录下存在同名原始文件 —— 仅凭文件名模式删除会误删用户自己的
   * `report.rewind-2024.tmp` 这类文件。
   */
  async collectLeftoverTmp(sessionId, cwd) {
    const root = cwd;
    const stack = [''];
    while (stack.length > 0) {
      const relDir = stack.pop();
      const absDir = relDir === '' ? root : fromRel(root, relDir);
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase();
          if (ALWAYS_SKIP.has(lower) || this.exclude.has(lower)) continue;
          stack.push(rel);
          continue;
        }
        if (!entry.isFile()) continue;
        const match = /^(.+)\.rewind-(\d+)\.tmp$/.exec(entry.name);
        if (match === null) continue;
        // 只清理本进程 pid 的临时文件（跨进程时可能是别人正在写的）
        if (Number(match[2]) !== process.pid) continue;
        // 同名原始文件仍存在，才说明这是"复制到一半失败"的残留
        const originalRel = relDir === '' ? match[1] : `${relDir}/${match[1]}`;
        if (!(await exists(fromRel(root, originalRel)))) continue;
        await rm(fromRel(root, rel), { force: true }).catch(() => undefined);
      }
    }
  }

  /** 回退后收拾清单：丢掉目标之后的旧清单，按当前磁盘补一份新的。 */
  async finishRestore(sessionId, targetSeq, markerSeq, cwd) {
    const keys = await this.listManifestKeys(sessionId);
    for (const key of keys) {
      if (key > targetSeq) await rm(this.manifestPath(sessionId, key), { force: true }).catch(() => undefined);
    }
    if (!Number.isSafeInteger(markerSeq)) return;
    const target = await this.stateAt(sessionId, targetSeq);
    const current = await walkWorkspace(cwd, this.exclude);
    const files = {};
    for (const [rel, info] of current) {
      const before = target?.files?.[rel];
      // 只在 size 与 mtime 都与目标清单一致时才复用其摘要。早先仅比 size：
      // 同尺寸但内容不同的文件会背上错误的 hash，之后以该落点为目标回退会还原错内容。
      // 无法确认时写 null —— 下一次边界记录会重新计算真实摘要。
      const trustworthy =
        before !== undefined && before[0] === info.size && before[1] === info.mtime && typeof before[2] === 'string';
      files[rel] = [info.size, info.mtime, trustworthy ? before[2] : null];
    }
    await writeJsonAtomic(this.manifestPath(sessionId, markerSeq), {
      v: MANIFEST_VERSION,
      key: markerSeq,
      at: Date.now(),
      cwd,
      files,
    }).catch(() => undefined);
  }
}

export { DEFAULT_EXCLUDE };