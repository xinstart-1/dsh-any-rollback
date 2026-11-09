// dsh-any-rollback · 全局内容寻址 blob 存储（跨会话共享）
//
// ── 41.8 GiB 快照膨胀事故 ───────────────────────────────────────────────
// 旧布局把每个会话的内容缓存写成
//   <root>/<sessionId>/artifacts/blobs/<sha256>
// 每个会话各算各的哈希、各去各的重，同一份字节在 N 个会话里就落 N 份。
// 实测某台机器 rewind-snapshots 占到 41.8 GiB，而按 sha256 去重后真正不同的
// 内容只有 15.5 GiB：约 26 GiB 是跨会话重复，再叠加每会话清单裁剪之后没人
// 回收的孤儿 blob，整个快照目录膨胀到 43 GB 级，把磁盘吃满。
//
// 本模块把 blob 提升为**全局唯一**的内容寻址池：
//   <root>/_blobs/<hash[0:2]>/<hash>
// 两级分片避免单目录堆积百万级文件；相同内容在磁盘上永远只有一份物理副本。
// 存活集合由调用方（index.js）跨**所有**会话、所有存活清单汇总后交给
// collectGarbage() 一次性回收，而不是像旧实现那样每会话各扫各的、互相看不见。
//
// 兼容与迁移：旧的每会话 blob 路径保持只读可访问（ensureLocal 会回退查找，
// restore 因此不必等迁移完成就能工作）；--compact 用 adopt() 把旧 blob 以
// **硬链接**方式并入全局池（NTFS 上是瞬时操作，所有链接都 unlink 之前不释放
// 空间，这是刻意的），随后 unlinkLegacy() 删掉旧链接才真正腾出重复占用的空间。
//
// 安全边界：哈希名一律经 64 位小写十六进制校验；_blobs 与分片目录都必须是
// 真实目录、目标必须是普通文件，任何符号链接都不跟随；除 unlinkLegacy() 删
// 一个旧文件、putFromTemp() 改写一个调用方自有的 tmp 外，本模块不写 _blobs
// 之外的任何路径。所有公共方法（除 init()）遇到 ENOENT / 损坏 / 竞态一律
// 返回结果，不抛异常，方便批量扫描循环里直接调用。

import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// mkdtemp / readFile / writeFile 以及 node:os、node:url 仅供文件末尾的迷你自测
// 使用；库代码本身只依赖 node:fs/promises、node:crypto、node:path，无外部依赖。

// ── 常量与工具 ───────────────────────────────────────────────────────────

/** 内容寻址 blob 的合法名字：64 位小写十六进制 sha256。 */
const HASH_RE = /^[0-9a-f]{64}$/;
/** 分片目录名：hash 的前两位，同样是小写十六进制。 */
const SHARD_RE = /^[0-9a-f]{2}$/;
/** putFromTemp / adopt 遗留的临时文件前缀，collectGarbage 会顺手回收。 */
const TMP_PREFIX = '.tmp-';
/** 全局池目录名（位于快照根下）。 */
const BLOBS_DIR = '_blobs';
/** 流式哈希/复制的缓冲区：1 MiB，与 artifact-track.js 保持一致。 */
const ONE_MIB = 1 << 20;

/**
 * 流式计算文件 sha256（1 MiB 缓冲），顺带返回字节数。
 * 用 open/read 而不是 readFile：blob 可能有几十 MiB，不能整份进内存。
 * 这是 putFromTemp / adopt 复核「文件名 == 内容」的唯一入口。
 * @param {string} path
 * @returns {Promise<{hash: string, bytes: number}>}
 */
async function hashFile(path) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  let bytes = 0;
  try {
    const buf = Buffer.allocUnsafe(ONE_MIB);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { hash: hash.digest('hex'), bytes };
}

/**
 * 用 lstat 判断路径状态。刻意**不跟随符号链接**：blob 根里出现 symlink 一律
 * 视为不可信，绝不顺着它读写到快照根之外。ENOENT 不是错误，是正常缺席。
 * @param {string} path
 * @returns {Promise<'file'|'dir'|'symlink'|'other'|'missing'|'error'>}
 */
async function fileState(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return 'error';
  }
}

/** lstat 复核：必须是真实目录，不能是符号链接。 */
async function isRealDir(path) {
  return (await fileState(path)) === 'dir';
}

/**
 * 流式复制（只用 open/read/write，不引入 copyFile）：adopt 在硬链接失败
 * （EXDEV/EPERM）时的退化路径。目标以 'wx' 独占创建，避免覆盖别人的写入。
 * @param {string} src
 * @param {string} dst
 * @returns {Promise<number>} 复制的字节数
 */
async function copyStream(src, dst) {
  const reader = await open(src, 'r');
  const writer = await open(dst, 'wx');
  let total = 0;
  try {
    const buf = Buffer.allocUnsafe(ONE_MIB);
    for (;;) {
      const { bytesRead } = await reader.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let off = 0;
      while (off < bytesRead) {
        const { bytesWritten } = await writer.write(buf, off, bytesRead - off, null);
        if (bytesWritten <= 0) throw new Error('short write');
        off += bytesWritten;
      }
      total += bytesRead;
    }
  } finally {
    await writer.close().catch(() => undefined);
    await reader.close().catch(() => undefined);
  }
  return total;
}

/**
 * 可选的落盘刷写：打开目标文件并 fsync。Windows 需要 'r+' 才能
 * FlushFileBuffers，故先试 'r+' 再退化 'r'。失败只告警，不回滚已完成的 rename。
 * @param {string} path
 */
async function fsyncPath(path) {
  let handle;
  try {
    handle = await open(path, 'r+');
  } catch {
    handle = await open(path, 'r');
  }
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ── 会话 id 清洗（与 artifact-track.js 对齐，避免循环依赖）────────────────

/**
 * 会话 id → 单射的目录名。**必须**与 artifact-track.js 的 sanitizeId 对真实
 * id 得到完全一致的结果：旧的 `<root>/<sanitizeId(id)>/artifacts/blobs/` 是
 * artifact-track.js 用这套规则写的，对不上就读不到遗留 blob。
 *
 * 规则：只把非法字符替换成 `_`；只有「清洗确实改变了 id」才追加
 * sha256(raw).slice(0,10)，保证 `sess/A` 与 `sess_A` 不撞车。空串 / `.` /
 * `..` 这类会拼出根本身或逃出根的危险名统一归一到 `session`（这三点比
 * artifact-track.js 更保守：那边给 `.`/`..` 追加哈希、空串直接返回 `''`；
 * 这些都不是真实会话 id，不影响遗留数据兼容）。
 *
 * 刻意不 import artifact-track.js：那边将来要反过来依赖本模块，直接 import
 * 会形成循环依赖。这里保留一份等价的本地副本并以此注释锁定行为。
 * @param {unknown} id
 * @returns {string}
 */
function sanitizeId(id) {
  const raw = String(id);
  if (raw === '' || raw === '.' || raw === '..') return 'session';
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === raw) return safe;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return `${safe}-${digest}`;
}

// ── 路径与安全校验 ───────────────────────────────────────────────────────

/**
 * 准备 hash 对应的分片目录，并证明 `_blobs` 与分片两层都是真实目录。
 * 只要任一层是符号链接就返回 false —— 绝不顺着外链把数据写到快照根之外。
 * @param {string} root
 * @param {string} hash 已校验的 64hex
 * @returns {Promise<boolean>} 目录可安全写入才 true
 */
async function ensureShard(root, hash) {
  const blobsRoot = resolve(root, BLOBS_DIR);
  const shardDir = join(blobsRoot, hash.slice(0, 2));
  // 预检：_blobs 已存在但不是真实目录 → 拒绝；尚不存在（ENOENT）交给 mkdir。
  const pre = await fileState(blobsRoot);
  if (pre !== 'dir' && pre !== 'missing') return false;
  try {
    await mkdir(shardDir, { recursive: true });
  } catch {
    return false;
  }
  // 复检：mkdir 之后两层都必须仍是真实目录（没被人换成符号链接）。
  return (await isRealDir(blobsRoot)) && (await isRealDir(shardDir));
}

/**
 * 只读地确认「全局池里确实有一份该 hash 的普通文件」。
 * 父目录两层必须是真实目录、目标必须是普通文件：任何一层是符号链接都不跟随。
 * @param {string} root
 * @param {string} hash 已校验的 64hex
 * @returns {Promise<string|undefined>} 可用则返回其绝对路径，否则 undefined
 */
async function safeGlobalFile(root, hash) {
  const blobsRoot = resolve(root, BLOBS_DIR);
  const dest = resolve(blobsRoot, hash.slice(0, 2), hash);
  if (!(await isRealDir(blobsRoot))) return undefined;
  if (!(await isRealDir(dirname(dest)))) return undefined;
  if ((await fileState(dest)) !== 'file') return undefined;
  return dest;
}

// ── BlobStore ─────────────────────────────────────────────────────────────

/**
 * 全局内容寻址 blob 存储。
 *
 * 所有公共方法（除 init()）都是「全函数」：遇到 ENOENT、损坏、竞态、非法输入
 * 都返回规定形状的结果，不抛异常，方便在扫描 / 压缩的批量循环里直接调用。
 */
export class BlobStore {
  /**
   * @param {object} opts
   * @param {() => string} opts.rootDir 快照根目录（插件 store.root）的惰性取值器
   * @param {{warn?: Function, info?: Function}} [opts.logger] 可选日志
   * @param {boolean} [opts.fsync=false] 新写入后是否 fsync 目标文件
   */
  constructor(opts = {}) {
    this.rootOf = opts.rootDir;
    this.logger = opts.logger;
    this.fsync = opts.fsync === true;
  }

  /** 惰性取根；取不到时公共方法全部退化为「无操作」而不是抛异常。 */
  root() {
    let value;
    try {
      value = typeof this.rootOf === 'function' ? this.rootOf() : this.rootOf;
    } catch {
      return undefined;
    }
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') {
      this.logger.warn(`[dsh-rewind-blobs] ${message}`);
    }
  }

  info(message) {
    if (typeof this.logger?.info === 'function') {
      this.logger.info(`[dsh-rewind-blobs] ${message}`);
    }
  }

  /** 全局池根目录 `_blobs` 的绝对路径。 */
  globalDir() {
    const root = this.root();
    return root === undefined ? undefined : resolve(root, BLOBS_DIR);
  }

  /**
   * 把 64hex 哈希映射成全局分片绝对路径（**同步**）。
   *
   * 名字是**不受信任输入**：只接受 `/^[0-9a-f]{64}$/`，因此不可能含 `/`、
   * `..`、盘符或反斜杠，路径穿越在校验这一步就被彻底挡掉。非法输入返回
   * undefined 并告警，绝不「尽力拼一个路径」。
   * @param {unknown} hash
   * @returns {string|undefined}
   */
  globalPath(hash) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      this.warn(`refusing invalid blob hash: ${String(hash).slice(0, 40)}`);
      return undefined;
    }
    const root = this.root();
    if (root === undefined) return undefined;
    return resolve(root, BLOBS_DIR, hash.slice(0, 2), hash);
  }

  /**
   * 旧版每会话 blob 目录：`<root>/<sanitizeId(id)>/artifacts/blobs`。
   * 用 relative() 复核它确实落在根内，防止 sanitizeId 将来被改坏而越权。
   * @param {string} sessionId
   * @returns {string|undefined}
   */
  legacyDir(sessionId) {
    const root = this.root();
    if (root === undefined) return undefined;
    const dir = join(root, sanitizeId(sessionId), 'artifacts', 'blobs');
    const inside = relative(resolve(root), dir);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
    return dir;
  }

  /** 旧版某个 blob 的绝对路径；hash 非法或路径不可信返回 undefined。 */
  legacyPath(sessionId, hash) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return undefined;
    const dir = this.legacyDir(sessionId);
    return dir === undefined ? undefined : join(dir, hash);
  }

  /**
   * 幂等创建全局池根目录 `_blobs`。这是唯一允许抛错的公共方法（配置 / 权限
   * 问题应该让插件启动时就失败，而不是静默降级）；已存在但是符号链接时拒绝。
   * @returns {Promise<void>}
   */
  async init() {
    const dir = this.globalDir();
    if (dir === undefined) {
      throw new Error('[dsh-rewind-blobs] rootDir() 必须返回非空字符串');
    }
    let st;
    try {
      st = await lstat(dir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (st !== undefined && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new Error(`[dsh-rewind-blobs] _blobs 不是真实目录，拒绝初始化: ${dir}`);
    }
    await mkdir(dir, { recursive: true });
  }

  /**
   * 把一个调用方已经写好字节、并算好 sha256 的 tmp 文件收编进全局池。
   *
   * 即便调用方给了哈希也**必须重算一遍**：tmp 可能被截断、被别的进程改写，
   * 不复核就 rename 会把错误内容以正确名字存进池里（静默数据损坏）。命中已有
   * 内容时直接删 tmp 返回去重结果；否则同卷 rename 原子落盘。失败时 tmp 归
   * 调用方所有，本方法不擅自删除。
   *
   * @param {string} tmpFile 调用方自有的临时文件（通常在会话 blobs 目录内）
   * @param {string} hash 调用方算出的 sha256
   * @returns {Promise<{ok: boolean, reason?: string, deduped?: boolean, bytes: number, actual?: string}>}
   */
  async putFromTemp(tmpFile, hash) {
    const dest = this.globalPath(hash);
    if (dest === undefined || typeof tmpFile !== 'string' || tmpFile === '') {
      return { ok: false, reason: 'invalid-input', bytes: 0 };
    }
    const root = this.root();
    if (root === undefined) return { ok: false, reason: 'no-root', bytes: 0 };
    // tmp 本身也不能是符号链接，否则 open 会跟到快照根之外去读。
    if ((await fileState(tmpFile)) !== 'file') {
      return { ok: false, reason: 'invalid-temp', bytes: 0 };
    }
    let computed;
    try {
      computed = await hashFile(tmpFile);
    } catch {
      return { ok: false, reason: 'unreadable', bytes: 0 };
    }
    if (computed.hash !== hash) {
      return { ok: false, reason: 'hash-mismatch', bytes: 0, actual: computed.hash };
    }
    const size = computed.bytes;
    // 建分片（同时证明 _blobs 与分片都是真实目录，不跟符号链接）。
    if (!(await ensureShard(root, hash))) {
      return { ok: false, reason: 'unsafe-path', bytes: 0 };
    }
    const state = await fileState(dest);
    if (state === 'file') {
      await rm(tmpFile, { force: true }).catch(() => undefined);
      return { ok: true, deduped: true, bytes: 0 };
    }
    if (state === 'symlink' || state === 'dir') {
      return { ok: false, reason: 'unsafe-dest', bytes: 0 };
    }
    try {
      await rename(tmpFile, dest);
    } catch (error) {
      // Windows 上目标已存在会抛 EEXIST：说明另一个写入者抢先落盘了。
      if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES') {
        if ((await safeGlobalFile(root, hash)) !== undefined) {
          await rm(tmpFile, { force: true }).catch(() => undefined);
          return { ok: true, deduped: true, bytes: 0 };
        }
      }
      return { ok: false, reason: 'rename-failed', bytes: 0 };
    }
    if (this.fsync) {
      try {
        await fsyncPath(dest);
      } catch {
        this.warn(`fsync failed for ${hash.slice(0, 12)} (bytes already renamed)`);
      }
    }
    return { ok: true, deduped: false, bytes: size };
  }

  /**
   * restore 用的**只读**查路径：全局池命中就返回全局路径，否则回退到旧版
   * 每会话 blob 路径；两者都没有返回 undefined。全程不写任何文件。
   *
   * 这是「遗留数据不必先迁移也能还原」的关键：新的写入走全局池，老的读取
   * 仍能落在 `<root>/<sessionId>/artifacts/blobs/<hash>`。
   * @param {string} sessionId
   * @param {string} hash
   * @returns {Promise<string|undefined>}
   */
  async ensureLocal(sessionId, hash) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return undefined;
    const root = this.root();
    if (root === undefined) return undefined;
    const global = await safeGlobalFile(root, hash);
    if (global !== undefined) return global;
    const legacy = this.legacyPath(sessionId, hash);
    if (legacy !== undefined && (await fileState(legacy)) === 'file') return legacy;
    return undefined;
  }

  /**
   * --compact 的一次性迁移：把旧版每会话 blob 并入全局池。
   *
   * 首选硬链接（NTFS 上是瞬时操作；所有链接都 unlink 之前不释放空间，这是
   * 刻意的 —— 之后由 unlinkLegacy() 删旧链接才真正腾出重复占用）。跨卷 /
   * 不支持硬链接时退化为「流复制到分片内 .tmp- + 复核 + rename」。
   * `reclaimed` 表示 unlinkLegacy() 之后**可**释放的字节数，不代表本次已释放。
   * `dryRun` 只做校验与报告，绝不 mkdir / link / rename。
   *
   * @param {string} sessionId
   * @param {string} hash
   * @param {{dryRun?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, reason?: string, action?: string, bytes: number, reclaimed: number, dryRun?: boolean, via?: string}>}
   */
  async adopt(sessionId, hash, opts = {}) {
    const dryRun = opts?.dryRun === true;
    const invalid = { ok: false, reason: 'invalid-input', bytes: 0, reclaimed: 0, dryRun };
    const dest = this.globalPath(hash);
    const root = this.root();
    const legacy = this.legacyPath(sessionId, hash);
    if (dest === undefined || root === undefined || legacy === undefined) return invalid;
    // ① 全局池已有该内容：按契约直接返回，连旧 blob 在不在都不必看。
    // 此时没有「本次迁移」发生，reclaimed 记 0（旧链接若还在，调用方后续
    // unlinkLegacy() 仍可回收，但那不属于本次 adopt 的语义）。
    if ((await safeGlobalFile(root, hash)) !== undefined) {
      return { ok: true, action: 'already-global', bytes: 0, reclaimed: 0, dryRun };
    }
    const legacyState = await fileState(legacy);
    if (legacyState !== 'file') {
      return {
        ok: false,
        reason: legacyState === 'missing' ? 'missing-legacy' : 'unsafe-legacy',
        bytes: 0,
        reclaimed: 0,
        dryRun,
      };
    }
    // 迁移前必须复核旧 blob 完整性，否则会把坏字节硬链接进全局池。
    let computed;
    try {
      computed = await hashFile(legacy);
    } catch {
      return { ok: false, reason: 'unreadable', bytes: 0, reclaimed: 0, dryRun };
    }
    if (computed.hash !== hash) {
      return { ok: false, reason: 'corrupt', bytes: 0, reclaimed: 0, dryRun };
    }
    const reclaimed = computed.bytes;
    if (dryRun) {
      return { ok: true, action: 'would-adopt', bytes: 0, reclaimed, dryRun };
    }
    if (!(await ensureShard(root, hash))) {
      return { ok: false, reason: 'unsafe-path', bytes: 0, reclaimed: 0, dryRun };
    }
    // ① 首选硬链接：不复制字节，旧链接与全局副本共享同一 inode。
    try {
      await link(legacy, dest);
      return { ok: true, action: 'adopted', bytes: 0, reclaimed, via: 'link' };
    } catch (error) {
      // 并发：另一个 --compact 已经链接好了。
      if (error?.code === 'EEXIST' && (await safeGlobalFile(root, hash)) !== undefined) {
        return { ok: true, action: 'already-global', bytes: 0, reclaimed, dryRun };
      }
      // 其余（EXDEV / EPERM / EMLINK / ENOSYS...）走 ② 复制退化路径。
    }
    // ② 复制退化：tmp 落在分片内（_blobs 之内），校验后原子 rename。
    const tmp = join(
      dirname(dest),
      `${TMP_PREFIX}adopt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      await copyStream(legacy, tmp);
      const copied = await hashFile(tmp);
      if (copied.hash !== hash) {
        return { ok: false, reason: 'copy-corrupt', bytes: 0, reclaimed: 0, dryRun };
      }
      await rename(tmp, dest);
    } catch (error) {
      if (error?.code === 'EEXIST' && (await safeGlobalFile(root, hash)) !== undefined) {
        return { ok: true, action: 'already-global', bytes: 0, reclaimed, dryRun };
      }
      return { ok: false, reason: 'copy-failed', bytes: 0, reclaimed: 0, dryRun };
    } finally {
      // rename 成功时 tmp 已不存在，force:true 兜底；失败时清掉半成品。
      await rm(tmp, { force: true }).catch(() => undefined);
    }
    return { ok: true, action: 'adopted', bytes: 0, reclaimed, via: 'copy' };
  }

  /**
   * 迁移完成后只删旧版每会话 blob 文件（**绝不碰全局池里的那一份**）。
   * 硬链接场景下这正是释放重复占用的那一步。ENOENT 视为已删，不抛异常。
   * @param {string} sessionId
   * @param {string} hash
   * @returns {Promise<number>} 释放的字节数；没有可删的返回 0
   */
  async unlinkLegacy(sessionId, hash) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return 0;
    const root = this.root();
    if (root === undefined) return 0;
    const legacy = this.legacyPath(sessionId, hash);
    if (legacy === undefined) return 0;
    // 双保险：确认这个路径不在 _blobs 之内，绝不可能误删全局副本。
    const insideGlobal = relative(resolve(root, BLOBS_DIR), legacy);
    if (insideGlobal !== '' && !insideGlobal.startsWith('..') && !isAbsolute(insideGlobal)) return 0;
    if ((await fileState(legacy)) !== 'file') return 0;
    try {
      const size = (await lstat(legacy)).size;
      await rm(legacy, { force: true });
      return size;
    } catch {
      return 0;
    }
  }

  /**
   * 全局垃圾回收：删掉所有不在 liveHashes 里的 blob，顺手清掉 `.tmp-` 残留。
   *
   * liveHashes 由调用方跨**所有**会话、所有存活清单汇总而来 —— 这是与旧实现
   * 每会话各扫各的最关键区别。只认 64hex 名字与 `.tmp-` 前缀，别的名字一律
   * 不碰；分片目录与文件都必须是真实目录 / 普通文件，符号链接不跟不删。
   * maxDeleteBytes 是安全阀：累计删除量达到上限立刻停，避免一次误算清掉整池。
   * dryRun 只统计、不落任何写操作。
   *
   * @param {Set<string>|Iterable<string>} liveHashes 跨全部存活清单汇总的 64hex 集合
   * @param {{dryRun?: boolean, maxDeleteBytes?: number}} [opts]
   * @returns {Promise<{removed: number, removedBytes: number, kept: number, dryRun: boolean}>}
   */
  async collectGarbage(liveHashes, opts = {}) {
    const dryRun = opts?.dryRun === true;
    const cap = Number.isFinite(opts?.maxDeleteBytes)
      ? Math.max(0, opts.maxDeleteBytes)
      : Infinity;
    // 宽限期：比这个更新的 blob 一律不动，给「已写字节、还没写清单」的窗口
    // 兜底（见 ArtifactTracker 的 GC_GRACE_MS）。未指定则 0 = 不启用。
    const graceMs = Number.isFinite(opts?.graceMs) && opts.graceMs > 0 ? opts.graceMs : 0;
    const protectedAfter = graceMs > 0 ? Date.now() - graceMs : undefined;
    const live = liveHashes instanceof Set ? liveHashes : new Set(Array.from(liveHashes ?? []));
    const result = { removed: 0, removedBytes: 0, kept: 0, dryRun };
    const blobsRoot = this.globalDir();
    if (blobsRoot === undefined) return result;
    if (!(await isRealDir(blobsRoot))) return result; // 不存在或是符号链接：不动
    let shards;
    try {
      shards = await readdir(blobsRoot, { withFileTypes: true });
    } catch {
      return result;
    }
    /** @returns {Promise<boolean>} false 表示已达删除上限，调用方应停止扫描 */
    const consider = async (path, name, size, isBlob) => {
      if (isBlob && live.has(name)) {
        result.kept++;
        return true;
      }
      if (isBlob && protectedAfter !== undefined) {
        // 宽限期内的孤儿先留着：它可能正处在「字节已落仓、清单未落盘」的窗口。
        let mtimeMs;
        try {
          mtimeMs = (await lstat(path)).mtimeMs;
        } catch {
          return true; // 读不到就当它已经不在了，不计数
        }
        if (mtimeMs >= protectedAfter) {
          result.kept++;
          return true;
        }
      }
      if (cap !== Infinity && (result.removedBytes >= cap || result.removedBytes + size > cap)) {
        return false;
      }
      if (!dryRun) {
        try {
          await rm(path, { force: true });
        } catch {
          return true; // 单个文件删不掉就跳过，不中断整轮
        }
      }
      result.removed++;
      result.removedBytes += size;
      return true;
    };
    outer:
    for (const shard of shards) {
      if (shard.isSymbolicLink()) continue;
      if (!shard.isDirectory()) {
        // 池根目录下只处理 .tmp- 残留（正常写入都落在分片里）。
        if (shard.isFile() && shard.name.startsWith(TMP_PREFIX)) {
          const path = join(blobsRoot, shard.name);
          let size;
          try { size = (await lstat(path)).size; } catch { continue; }
          if (!(await consider(path, shard.name, size, false))) break outer;
        }
        continue;
      }
      if (!SHARD_RE.test(shard.name)) continue; // 不扫来历不明的目录
      const shardDir = join(blobsRoot, shard.name);
      let entries;
      try {
        entries = await readdir(shardDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) continue;
        const name = entry.name;
        const isBlob = HASH_RE.test(name);
        if (!isBlob && !name.startsWith(TMP_PREFIX)) continue; // 别的名字不归本模块管
        const path = join(shardDir, name);
        let size;
        try { size = (await lstat(path)).size; } catch { continue; }
        if (!(await consider(path, name, size, isBlob))) break outer;
      }
    }
    return result;
  }

  /**
   * 统计全局池里所有 blob 的文件数与总字节（用 lstat 的真实大小），供配额使用。
   * 只数 64hex 普通文件：`.tmp-` 残留、符号链接、别的名字都不计入。
   * @returns {Promise<{files: number, bytes: number}>}
   */
  async stats() {
    const result = { files: 0, bytes: 0 };
    const blobsRoot = this.globalDir();
    if (blobsRoot === undefined) return result;
    if (!(await isRealDir(blobsRoot))) return result;
    let shards;
    try {
      shards = await readdir(blobsRoot, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const shard of shards) {
      if (shard.isSymbolicLink() || !shard.isDirectory()) continue;
      if (!SHARD_RE.test(shard.name)) continue;
      const shardDir = join(blobsRoot, shard.name);
      let entries;
      try {
        entries = await readdir(shardDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!HASH_RE.test(entry.name)) continue;
        if (entry.isSymbolicLink() || !entry.isFile()) continue;
        try {
          const st = await lstat(join(shardDir, entry.name));
          result.files++;
          result.bytes += st.size;
        } catch {
          // 并发删除，跳过即可
        }
      }
    }
    return result;
  }

  /**
   * 枚举某会话的旧版 blob 目录，供 --compact 逐个 adopt()。
   * 只返回名字合法的 64hex 普通文件；`.tmp-` 残留计数放在返回数组的
   * `tmpCount` 属性上，不混进结果列表。
   * @param {string} sessionId
   * @returns {Promise<Array<{name: string, path: string, size: number}> & {tmpCount: number}>}
   */
  async listLegacy(sessionId) {
    const out = [];
    out.tmpCount = 0;
    const dir = this.legacyDir(sessionId);
    if (dir === undefined) return out;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out; // 旧目录不存在是正常的（新会话根本没有 legacy blob）
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(TMP_PREFIX)) {
        out.tmpCount++;
        continue;
      }
      if (!HASH_RE.test(name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      const path = join(dir, name);
      try {
        const size = (await lstat(path)).size;
        out.push({ name, path, size });
      } catch {
        // 并发删除，跳过
      }
    }
    return out;
  }
}

// ── 自测（仅直接 `node lib/blob-store.js` 时执行，import 绝不会触发）──────

/**
 * 迷你回归测试：不依赖测试框架，跑完打印 PASS/FAIL，失败设 process.exitCode=1。
 * 只在 OS 临时目录（mkdtemp）里造数据，绝不碰真实的 ~/.dsh/rewind-snapshots。
 */
async function selfTest() {
  let failed = 0;
  const check = (label, ok, extra = '') => {
    if (ok) {
      console.log(`PASS ${label}`);
    } else {
      failed++;
      console.log(`FAIL ${label}${extra ? ` :: ${extra}` : ''}`);
    }
  };
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), 'dsh-blob-store-'));
    const store = new BlobStore({
      rootDir: () => root,
      logger: { warn: () => {}, info: () => {} },
    });
    await store.init();
    check('init() 创建 _blobs', (await fileState(join(root, BLOBS_DIR))) === 'dir');
    await store.init();
    check('init() 幂等', (await fileState(join(root, BLOBS_DIR))) === 'dir');

    // 三个 tmp：两个内容相同（应去重成一个物理副本），一个不同。
    const sessBlobs = join(root, 'sess-put', 'artifacts', 'blobs');
    await mkdir(sessBlobs, { recursive: true });
    const contentA = 'alpha-content';
    const contentB = 'alpha-content'; // 与 A 完全相同
    const contentC = 'beta-content';
    const hashA = sha(contentA);
    const hashC = sha(contentC);
    const tmpA = join(sessBlobs, '.tmp-a');
    const tmpB = join(sessBlobs, '.tmp-b');
    const tmpC = join(sessBlobs, '.tmp-c');
    await Promise.all([
      writeFile(tmpA, contentA),
      writeFile(tmpB, contentB),
      writeFile(tmpC, contentC),
    ]);

    const r1 = await store.putFromTemp(tmpA, hashA);
    check('putFromTemp 新写入',
      r1.ok === true && r1.deduped === false && r1.bytes === contentA.length,
      JSON.stringify(r1));
    const r2 = await store.putFromTemp(tmpB, hashA);
    check('putFromTemp 相同内容去重',
      r2.ok === true && r2.deduped === true && r2.bytes === 0,
      JSON.stringify(r2));
    const r3 = await store.putFromTemp(tmpC, hashC);
    check('putFromTemp 不同内容另存',
      r3.ok === true && r3.deduped === false && r3.bytes === contentC.length,
      JSON.stringify(r3));
    check('去重后 tmp 已被清理',
      (await fileState(tmpA)) === 'missing'
      && (await fileState(tmpB)) === 'missing'
      && (await fileState(tmpC)) === 'missing');

    // 哈希不匹配必须拒绝（tmp 归调用方，本方法不删）。
    const bad = join(sessBlobs, '.tmp-bad');
    await writeFile(bad, 'totally-different');
    const rBad = await store.putFromTemp(bad, hashA);
    check('putFromTemp 哈希不符拒绝',
      rBad.ok === false && rBad.reason === 'hash-mismatch', JSON.stringify(rBad));
    await rm(bad, { force: true });

    // 物理副本数：全局池里恰好 2 个 blob。
    const s1 = await store.stats();
    check('stats() 去重后仅 2 份物理副本', s1.files === 2, JSON.stringify(s1));
    check('stats() 字节数正确',
      s1.bytes === contentA.length + contentC.length, JSON.stringify(s1));
    check('globalPath 分片布局',
      store.globalPath(hashA).endsWith(join(BLOBS_DIR, hashA.slice(0, 2), hashA)));
    check('globalPath 拒绝路径注入',
      store.globalPath('../../etc/passwd') === undefined
      && store.globalPath('ABC') === undefined);

    // ensureLocal 两个方向：全局命中 + 旧版回退。
    const hitGlobal = await store.ensureLocal('sess-put', hashA);
    check('ensureLocal 命中全局', hitGlobal === store.globalPath(hashA), String(hitGlobal));

    const contentL = 'legacy-gamma';
    const hashL = sha(contentL);
    const legacyBlobs = join(root, 'sess-legacy', 'artifacts', 'blobs');
    await mkdir(legacyBlobs, { recursive: true });
    const legacyFile = join(legacyBlobs, hashL);
    await writeFile(legacyFile, contentL);
    const hitLegacy = await store.ensureLocal('sess-legacy', hashL);
    check('ensureLocal 回退到旧版 blob',
      hitLegacy === store.legacyPath('sess-legacy', hashL), String(hitLegacy));
    check('ensureLocal 全无时返回 undefined',
      (await store.ensureLocal('sess-legacy', sha('never-existed'))) === undefined);

    // adopt：dryRun 不写 → 硬链接迁移 → 重复 adopt 变 already-global。
    const dry = await store.adopt('sess-legacy', hashL, { dryRun: true });
    check('adopt dryRun 只报告不写',
      dry.ok === true && dry.action === 'would-adopt'
      && dry.reclaimed === contentL.length
      && (await fileState(store.globalPath(hashL))) === 'missing',
      JSON.stringify(dry));
    const adopted = await store.adopt('sess-legacy', hashL);
    check('adopt 硬链接迁移',
      adopted.ok === true && adopted.action === 'adopted'
      && adopted.reclaimed === contentL.length, JSON.stringify(adopted));
    const gPath = store.globalPath(hashL);
    check('迁移后全局副本内容一致', (await readFile(gPath, 'utf8')) === contentL);
    check('迁移后旧链接仍在', (await fileState(legacyFile)) === 'file');
    check('迁移后 ensureLocal 改指向全局',
      (await store.ensureLocal('sess-legacy', hashL)) === gPath);
    const again = await store.adopt('sess-legacy', hashL);
    check('重复 adopt → already-global',
      again.ok === true && again.action === 'already-global'
      && again.bytes === 0 && again.reclaimed === 0, JSON.stringify(again));
    // already-global 优先于 legacy 检查：旧文件已不在也照样直接返回。
    const noLegacy = await store.adopt('no-such-session', hashL);
    check('already-global 优先于 legacy 存在性',
      noLegacy.ok === true && noLegacy.action === 'already-global', JSON.stringify(noLegacy));

    // 损坏的旧 blob 必须拒绝迁移。
    const corruptHash = sha('expected-but-not-the-bytes');
    const corruptFile = join(legacyBlobs, corruptHash);
    await writeFile(corruptFile, 'tampered');
    const corrupt = await store.adopt('sess-legacy', corruptHash);
    check('adopt 拒绝损坏 blob',
      corrupt.ok === false && corrupt.reason === 'corrupt', JSON.stringify(corrupt));
    await rm(corruptFile, { force: true });

    // unlinkLegacy 只删旧文件，全局副本必须还在。
    const freed = await store.unlinkLegacy('sess-legacy', hashL);
    check('unlinkLegacy 返回释放字节', freed === contentL.length, String(freed));
    check('unlinkLegacy 不碰全局副本',
      (await fileState(gPath)) === 'file' && (await fileState(legacyFile)) === 'missing');
    check('unlinkLegacy 幂等（ENOENT 不抛）',
      (await store.unlinkLegacy('sess-legacy', hashL)) === 0);

    // listLegacy：跳过 .tmp- 并单独计数。
    await writeFile(join(legacyBlobs, '.tmp-leftover'), 'junk');
    const listed = await store.listLegacy('sess-legacy');
    check('listLegacy 跳过 .tmp- 并计数',
      listed.length === 0 && listed.tmpCount === 1,
      JSON.stringify({ length: listed.length, tmpCount: listed.tmpCount }));

    // 再造一个不在 live 集合里的全局 blob，让回收计数更明确。
    const contentD = 'delta-content';
    const hashD = sha(contentD);
    const tmpD = join(sessBlobs, '.tmp-d');
    await writeFile(tmpD, contentD);
    const r4 = await store.putFromTemp(tmpD, hashD);
    check('putFromTemp 第四份内容', r4.ok === true && r4.deduped === false, JSON.stringify(r4));

    // collectGarbage：分片内造一个 .tmp- 残留 + 一个无关文件。
    const shardA = dirname(store.globalPath(hashA));
    const tmpGlobal = join(shardA, '.tmp-gc');
    const stray = join(shardA, 'not-a-blob.txt');
    await writeFile(tmpGlobal, 'partial');
    await writeFile(stray, 'keep-me');
    const live = new Set([hashA, hashL]);
    const gcDry = await store.collectGarbage(live, { dryRun: true });
    check('collectGarbage dryRun 不删除',
      gcDry.dryRun === true && gcDry.removed >= 3
      && (await fileState(store.globalPath(hashC))) === 'file',
      JSON.stringify(gcDry));
    const capped = await store.collectGarbage(new Set(), { dryRun: true, maxDeleteBytes: 1 });
    check('collectGarbage 尊重 maxDeleteBytes',
      capped.removedBytes === 0, JSON.stringify(capped));
    const gc = await store.collectGarbage(live);
    check('collectGarbage 删除非存活 blob',
      (await fileState(store.globalPath(hashC))) === 'missing'
      && (await fileState(store.globalPath(hashD))) === 'missing'
      && gc.removed >= 3 && gc.removedBytes > 0,
      JSON.stringify(gc));
    check('collectGarbage 保留 live blob',
      (await fileState(store.globalPath(hashA))) === 'file'
      && (await fileState(gPath)) === 'file' && gc.kept === 2,
      JSON.stringify(gc));
    check('collectGarbage 清掉 .tmp- 残留', (await fileState(tmpGlobal)) === 'missing');
    check('collectGarbage 不删非 blob 名字', (await fileState(stray)) === 'file');

    const s2 = await store.stats();
    check('回收后 stats() 与 live 集合一致',
      s2.files === 2 && s2.bytes === contentA.length + contentL.length,
      JSON.stringify(s2));

    // 收尾：只删本次 mkdtemp 建出来的临时目录。
    await rm(root, { recursive: true, force: true });
    root = undefined;
    console.log(failed === 0
      ? 'blob-store self-test: ALL PASS'
      : `blob-store self-test: ${failed} FAIL`);
  } catch (error) {
    failed++;
    console.error('FAIL self-test threw:', error);
  } finally {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    if (failed > 0) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfTest();
}
