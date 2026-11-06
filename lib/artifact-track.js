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
//
// ── 跨会话安全模型（v0.19.1-any.19 重写）────────────────────────────────
//
// 清单是按 cwd **全量扫描**的，同一工作区里每个会话都记「整个工作区某时刻
// 的样子」。只靠清单无法回答「这个路径现在这份字节是谁写的」——旧实现拿
// (size, mtime) 和「别的会话更晚的清单」当代理，结果两条都不可靠：
//   - 别的会话新建的文件在它自己的清单里 (size, mtime) 与当前磁盘天然相等
//     → 判据恒 false → 新建文件永远不被判 foreign（真实事故：A 的回退把 B
//     的 78 行改动和两个新建测试文件一起撤掉）；
//   - 同 size + 保 mtime 的改写完全漏判；wall-clock 比较在同时刻/prune/时钟
//     回拨下失效；cwd 尾斜杠差异让整份清单被当成无关项目跳过。
//
// 现在的模型只有一条判据：**内容 sha256 + 本会话自己的写入归属账本**
// （`owned.json`，记录本会话最后一次写/删的路径与哈希）。
//   - 只有当「当前磁盘字节的哈希」等于**本会话账本**记录的哈希时，才认为
//     这个路径的现状是本会话造成的，才允许还原/移走；
//   - 别的会话账本若声称同一份哈希 → 归属有歧义 → 保守跳过；
//   - 本会话没有该路径的账本记录（无法证明是自己的产物）→ 一律跳过。
// 账本在**每次回合结束**按「与上一份清单的差异」更新，写类工具执行后也会
// 立即记账（`noteWrite`），因此别的会话正在改、还没落清单的文件也能被识别。
// 旧数据没有账本时退化为「别的会话清单里存在与磁盘同哈希的记录 → 判 foreign」，
// 仍然比旧的 (size, mtime) 判据可靠，且不会把所有文件都误判成别人的。
//
// 清单/账本都是磁盘上可写、跨进程共享的**不受信任输入**：所有 rel 一律经
// `resolveContained()` 做包含性校验，非法 rel/hash 直接跳过，绝不"尽力还原"。

import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BlobStore } from './blob-store.js';

const MANIFEST_VERSION = 1;
const OWNED_VERSION = 1;
/** 归属账本里「本会话写过该路径、但内容读不到（无哈希）」的哨兵值。 */
const UNKNOWN_HASH = '?';
// Only dependency/build directories that nobody rewinds. Dot-directories are
// NOT excluded by default: tooling often writes real artifacts into them.
const DEFAULT_EXCLUDE =
  'node_modules,dist,build,out,coverage,__pycache__,venv,.venv,target';

// 扫描上限（DoS 防线）：清单与回退都是全量遍历，没有上限时一个病态目录就能
// 把插件拖死。超过上限直接放弃本轮扫描（宁可没有清单，也不要在 8s 预算外
// 硬跑），由 coverage 诊断如实告知用户。
const MAX_SCAN_FILES = 200000;
const MAX_SCAN_DEPTH = 64;

// 会话 id 必须**单射**地映射到一个目录名。旧实现只把非法字符换成 `_`，
// 于是 `sess/A` 与 `sess_A` 落到同一个目录：两个会话共享同一份清单/blob/
// 隔离区，`foreignTouchedPaths` 还会按目录名「排除自己」把真正的另一个会话
// 一起排除 —— 跨会话检测完全失效。
//
// 修法：只有「清洗改变了 id」时才追加 id 的短哈希。正常 id（字母数字与
// `-_.`）映射不变 → 已发布的旧数据仍可读；被清洗过的 id 带上哈希 → 不可能
// 再与另一个 id 撞到同一目录（同 safe 前缀 + 同哈希意味着同一个 id）。
// `..`/`.` 这类危险名也走这条路径，得到 `..-<hash>` 这样的合法目录名，
// 不会逃出快照根。
function sanitizeId(id) {
  const raw = String(id);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === raw && safe !== '..' && safe !== '.') return safe;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return `${safe === '' ? 'session' : safe}-${digest}`;
}

function toRel(cwd, abs) {
  const rel = relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * 把清单里的相对路径解析成工作区内的绝对路径，**并证明它真的落在工作区内**。
 *
 * 清单是磁盘上的 JSON，跨进程/跨版本共享，属于**不受信任输入**：`loadManifest`
 * 只校验了版本号与 files 是 object，任何 rel 都可能被投毒成 `../x`、
 * `a/../../x`、`C:/Windows/x`、`/etc/passwd`、UNC 或 `sub\..\..\x`。
 * 旧实现直接 `join(cwd, ...rel.split('/'))` 拼路径，于是 restore 会把内容
 * 写到工作区外、甚至把工作区外的整棵目录 rename 进隔离区（已实测）。
 *
 * 规则：只接受 `/` 分隔、无空段、无 `.`/`..`/反斜杠/盘符/绝对路径的 rel，
 * 且 `resolve` 后的绝对路径经 `relative(cwd)` 复核仍在 cwd 内。
 * 返回 undefined 表示该 rel 不可信，调用方必须**跳过**它（绝不"尽力还原"）。
 *
 * @param {string} cwd 工作区绝对路径（调用方已规范化）
 * @param {string} rel 清单里的相对路径
 * @returns {string|undefined} 绝对路径，或 undefined（不可信）
 */
function resolveContained(cwd, rel) {
  if (typeof rel !== 'string' || rel === '') return undefined;
  // 反斜杠是 Windows 的路径分隔符：`sub\..\..\x` 在 POSIX 下只是一个文件名，
  // 在 Windows 下却能逃出工作区。一律拒绝，不给平台差异留口子。
  if (rel.includes('\\') || rel.includes('\0')) return undefined;
  const segments = rel.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return undefined;
    // 盘符（`C:`）与 NTFS 备用流（`x:y`）在 join 之前就必须挡住。
    if (/^[A-Za-z]:/.test(segment)) return undefined;
  }
  const root = resolve(cwd);
  const abs = resolve(root, ...segments);
  const inside = relative(root, abs);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return abs;
}

/** 内容寻址 blob 的合法名字：64 位小写十六进制 sha256。 */
const BLOB_NAME = /^[0-9a-f]{64}$/;

/**
 * 规范化工作区路径：`resolve` 之后尽量再 `realpath`。
 * 同一个目录可能以 `cwd`、`cwd/`、大小写变体、短名/长名、或经符号链接的路径
 * 出现；旧实现用字符串相等比较清单里的 cwd，尾斜杠不同就把整份清单当成
 * 「另一个项目」跳过 —— 跨会话检测因此失效（已实测）。比较一律用规范化结果。
 */
async function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  const resolved = resolve(cwd);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
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
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
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
  const stack = [{ rel: '', depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { rel: relDir, depth } = stack.pop();
    if (depth > MAX_SCAN_DEPTH) {
      throw new Error(`workspace scan aborted: directory depth over ${MAX_SCAN_DEPTH} at ${relDir}`);
    }
    const absDir = relDir === '' ? cwd : resolveContained(cwd, relDir);
    if (absDir === undefined) continue;
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
        stack.push({ rel, depth: depth + 1 });
        continue;
      }
      if (!dirent.isFile()) continue;
      // 还原流程自己的临时文件不是产物：一旦收进清单，下次回退会把它们
      // 当成"新建产物"移进隔离区（真实发生过）。
      if (/\.rewind-\d+\.tmp$/.test(name)) continue;
      visited++;
      if (visited > MAX_SCAN_FILES) {
        throw new Error(`workspace scan aborted: more than ${MAX_SCAN_FILES} files under ${cwd}`);
      }
      let info;
      try {
        info = await stat(resolveContained(cwd, rel) ?? join(absDir, name));
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
    // 全局内容寻址 blob 仓：所有会话共享同一份字节（按 sha256 去重）。
    // 旧布局是 <root>/<sid>/artifacts/blobs/<hash>，同一份视频在 N 个会话里
    // 存 N 份 —— 实测 41.8 GiB 里只有 15.5 GiB 是唯一内容，26 GiB 纯属跨会话重复。
    // 新写入一律进全局仓；读取时先查全局、再回退到旧会话目录（迁移前数据仍可读）。
    this.blobs = new BlobStore({
      rootDir: opts.rootDir,
      logger: opts.logger,
      fsync: opts.blobFsync === true,
    });
  }

  /** 全局仓首次使用前建目录；由宿主在 apply() 里调用，失败只告警不阻断。 */
  async initBlobs() {
    return this.blobs.init();
  }

  dirOf(sessionId) {
    return join(this.rootOf(), sanitizeId(sessionId), 'artifacts');
  }

  manifestsDir(sessionId) {
    return join(this.dirOf(sessionId), 'manifests');
  }

  /** @deprecated 旧版每会话 blob 目录；仅用于读取/迁移遗留数据，不再写入。 */
  blobsDir(sessionId) {
    return join(this.dirOf(sessionId), 'blobs');
  }

  quarantineDir(sessionId) {
    return join(this.dirOf(sessionId), 'quarantine');
  }

  manifestPath(sessionId, key) {
    return join(this.manifestsDir(sessionId), `${String(key).padStart(12, '0')}.json`);
  }

  /** 本会话的写入归属账本：本会话最后一次写/删每个路径留下的内容哈希。 */
  ownedPath(sessionId) {
    return join(this.dirOf(sessionId), 'owned.json');
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

  /**
   * 读取归属账本。不存在（旧数据）返回 undefined；损坏返回 undefined 并告警。
   * 结构：{ v, cwd, files: { rel: sha256|null } }，null 表示本会话把它删掉了。
   */
  async readOwned(sessionId) {
    let raw;
    try {
      raw = await readFile(this.ownedPath(sessionId), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || data.v !== OWNED_VERSION || typeof data.files !== 'object' || data.files === null) {
        this.warn(`owned ledger for ${sessionId} has an unrecognized shape; ignored`);
        return undefined;
      }
      const files = Object.create(null);
      for (const [rel, hash] of Object.entries(data.files)) {
        if (typeof rel !== 'string' || rel === '') continue;
        if (hash !== null && hash !== UNKNOWN_HASH && (typeof hash !== 'string' || !BLOB_NAME.test(hash))) continue;
        files[rel] = hash;
      }
      return { cwd: typeof data.cwd === 'string' ? data.cwd : undefined, files };
    } catch (error) {
      this.warn(
        `owned ledger for ${sessionId} is corrupt and was ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async writeOwned(sessionId, cwd, files) {
    await writeJsonAtomic(this.ownedPath(sessionId), {
      v: OWNED_VERSION,
      cwd,
      at: Date.now(),
      files,
    });
  }

  /**
   * 本会话账本 + 同一工作区里**其他会话**账本里对同一路径的声称。
   * 返回 { mine, others }：mine 是本会话记录的哈希（undefined=没记录，null=本会话删的），
   * others 是「别的会话声称的哈希」数组（null 表示别的会话把它删了）。
   *
   * 只读同一 cwd 的账本（cwd 规范化后比较）；读不到 cwd 的旧账本按「未知」处理，
   * 不参与判定（宁缺勿滥，误判 foreign 只会少动文件，不会误伤）。
   */
  /**
   * 一次 plan/restore 期间的「其他会话账本」快照缓存。
   *
   * 为什么必须缓存：`ownershipFor` 对**每个候选路径**都要遍历快照根目录下
   * 全部会话、逐个读 `owned.json` 并 JSON.parse，还要对每个 cwd 做 realpath。
   * 实测本机 44 个会话目录时单次调用 132ms；一次回退/预览有 157 个候选路径，
   * 累计 20 秒 —— 前端 8 秒超时，用户看到「preview request timed out」
   * （截图 image-23）。会话数与路径数相乘的重复 IO 是纯浪费：同一次 plan
   * 里其他会话的账本不可能变。
   *
   * 缓存按 cwd 归一化结果分组；键是 `sessionId|cwd`。同一次 plan 内复用，
   * plan 结束即丢弃（不跨请求，避免读到过期账本）。
   */
  async otherOwnedFor(sessionId, cwd, cache) {
    const key = `${sanitizeId(sessionId)}|${cwd ?? ''}`
    if (cache !== undefined && cache.has(key)) return cache.get(key)
    const build = async () => {
      const records = []
      let roots
      try {
        roots = await readdir(this.rootOf(), { withFileTypes: true })
      } catch {
        return { records, scanned: false }
      }
      const selfDir = sanitizeId(sessionId)
      for (const dirent of roots) {
        if (!dirent.isDirectory()) continue
        if (dirent.name === selfDir) continue
        const data = await this.readOwned(dirent.name)
        if (data === undefined) continue
        if (data.cwd !== undefined && cwd !== undefined && (await normalizeCwd(data.cwd)) !== cwd) continue
        records.push(data.files)
      }
      return { records, scanned: true }
    }
    const built = await build()
    if (cache !== undefined) cache.set(key, built)
    return built
  }

  /**
   * 返回 { mine, others }：mine 是本会话记录的哈希（undefined=没记录，null=本会话删的），
   * others 是「别的会话声称的哈希」数组（null 表示别的会话把它删了）。
   *
   * 只读同一 cwd 的账本（cwd 规范化后比较）；读不到 cwd 的旧账本按「未知」处理，
   * 不参与判定（宁缺勿滥，误判 foreign 只会少动文件，不会误伤）。
   *
   * @param {Map<string, object>} [cache] 同一次 plan/restore 内共享的账本缓存
   *   （见 {@link otherOwnedFor}）。省略时行为与逐次读取完全一致。
   */
  async ownershipFor(sessionId, rel, cwd, cache) {
    const mineData = await this.readOwned(sessionId);
    const mine = mineData !== undefined && mineData.files[rel] !== undefined ? mineData.files[rel] : undefined;
    const others = [];
    const { records, scanned } = await this.otherOwnedFor(sessionId, cwd, cache);
    for (const files of records) {
      if (files[rel] !== undefined) others.push(files[rel]);
    }
    return { mine, others, scanned };
  }

  /**
   * 判定「当前磁盘这份字节是否由本会话造成」。
   *
   * 判据只有内容哈希，没有 wall-clock、没有 (size, mtime)：
   *   - 本会话账本记录的哈希 === 当前哈希，且没有别的会话声称同一哈希
   *     → 'self'（唯一可能被推翻的情形是两份账本声称同一份字节，此时归属有
   *     歧义，保守按 'ambiguous' 处理）；
   *   - 别的会话声称当前哈希 → 'other'；
   *   - 本会话没有该路径的记录 / 记录与磁盘不符 → 'unknown'（不能证明是自己的
   *     产物，一律不动）。
   *
   * @returns {Promise<'self'|'other'|'ambiguous'|'unknown'>}
   */
  async lastWriterVerdict(sessionId, rel, cwd, diskHash, opts = {}) {
    const { mine, others } = await this.ownershipFor(sessionId, rel, cwd, opts.ledgerCache);
    if (typeof diskHash !== 'string' || !BLOB_NAME.test(diskHash)) {
      // 内容读不到（超大/无权限）：只能按「账本里谁记过这个路径」判断。
      // 只有本会话记过、且没有任何别的会话记过时，才允许当成自己的产物
      // （仅用于「移入隔离区」这种不动别人字节的保守动作）。
      if (mine === UNKNOWN_HASH && others.length === 0) {
        return opts.allowUnverified === true ? 'self-unverified' : 'unknown';
      }
      return mine === undefined ? 'unknown' : 'ambiguous';
    }
    if (others.some((hash) => hash === diskHash)) {
      return mine === diskHash ? 'ambiguous' : 'other';
    }
    if (mine === diskHash) return 'self';
    if (mine === UNKNOWN_HASH && others.length === 0) {
      // 本会话写过该路径但没算出哈希（超上限），现在又能读到字节：无法证明
      // 这份字节就是本会话写的那份，只有在允许「未验证的自有产物」时才放行。
      return opts.allowUnverified === true ? 'self-unverified' : 'unknown';
    }
    return 'unknown';
  }

  /** 供宿主侧 checkpoint 还原使用：这个绝对路径的现状是否可能属于别的会话。 */
  async isForeignAbsolute(sessionId, absPath) {
    const cwdRaw = this.cwdOf(sessionId);
    if (cwdRaw === undefined) return true; // 工作区未知：无法证明，保守拒绝
    const cwd = await normalizeCwd(cwdRaw);
    if (cwd === undefined) return true;
    const rel = toRel(cwd, resolve(absPath));
    if (rel === undefined) return true;
    let hash;
    try {
      hash = await sha256File(resolve(cwd, ...rel.split('/')));
    } catch {
      // 文件不存在：判断「谁把它删了」。本会话账本 null 才是自己删的。
      const { mine } = await this.ownershipFor(sessionId, rel, cwd);
      return mine !== null;
    }
    const verdict = await this.lastWriterVerdict(sessionId, rel, cwd, hash);
    return verdict !== 'self';
  }

  /**
   * 写类工具执行后立即记账（不必等回合结束）：别的会话在同一工作区里正在改
   * 一个还没落清单的文件时，这一步让 A 的回退能看见「这份字节是 B 写的」。
   * 只记账本会话自己的写入，失败不影响工具执行。
   */
  async noteWrite(sessionId, absPath, cwdHint) {
    try {
      const cwdRaw = cwdHint ?? this.cwdOf(sessionId);
      if (cwdRaw === undefined) return;
      const cwd = await normalizeCwd(cwdRaw);
      if (cwd === undefined) return;
      const rel = toRel(cwd, resolve(absPath));
      if (rel === undefined) return;
      const data = (await this.readOwned(sessionId)) ?? { cwd, files: Object.create(null) };
      if (data.cwd !== undefined && data.cwd !== cwd) {
        // 工作区变了：旧账本对本工作区没有意义，重新开始。
        data.files = Object.create(null);
      }
      let hash = null;
      try {
        hash = await sha256File(resolve(cwd, ...rel.split('/')));
      } catch {
        hash = null; // 工具把它删了
      }
      data.files[rel] = hash;
      await this.writeOwned(sessionId, cwd, data.files);
    } catch (error) {
      this.warn(`noteWrite failed for ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadManifest(sessionId, key, cwdHint) {
    let raw;
    try {
      raw = await readFile(this.manifestPath(sessionId, key), 'utf8');
    } catch {
      return undefined; // 文件不存在：正常
    }
    try {
      const data = JSON.parse(raw);
      // 清单是**不受信任输入**：形状与每个 rel/hash 都必须校验。旧实现只看
      // `v` 与 `files` 是 object，于是投毒清单能把还原写出工作区。
      if (!data || data.v !== MANIFEST_VERSION || typeof data.files !== 'object' || data.files === null) {
        this.warn(`manifest ${sessionId}/${key} has an unrecognized shape; it will be ignored`);
        return undefined;
      }
      const cwd = typeof data.cwd === 'string' && data.cwd !== '' ? resolve(data.cwd) : cwdHint;
      const files = Object.create(null);
      let rejected = 0;
      for (const [rel, entry] of Object.entries(data.files)) {
        if (typeof rel !== 'string' || rel === '') {
          rejected++;
          continue;
        }
        if (cwd !== undefined && resolveContained(cwd, rel) === undefined) {
          rejected++;
          continue;
        }
        if (!Array.isArray(entry) || entry.length !== 3) {
          rejected++;
          continue;
        }
        const [size, mtime, hash] = entry;
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime)) {
          rejected++;
          continue;
        }
        if (hash !== null && (typeof hash !== 'string' || !BLOB_NAME.test(hash))) {
          rejected++;
          continue;
        }
        files[rel] = [size, Math.round(mtime), hash];
      }
      if (rejected > 0) {
        this.warn(`manifest ${sessionId}/${key}: ${rejected} invalid entr(ies) were ignored`);
      }
      return { v: data.v, key, at: data.at, cwd, files };
    } catch (error) {
      // 清单损坏意味着这个时间点再也还原不了，绝不能静默退化成"无动作"。
      this.warn(
        `manifest ${sessionId}/${key} is corrupt and was ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** 目标消息对应的状态：最后一份 key 严格小于 targetSeq 的清单，否则基线（key 0）。 */
  async stateAt(sessionId, targetSeq, cwdHint) {
    const keys = await this.listManifestKeys(sessionId);
    let picked;
    for (const key of keys) {
      if (key < targetSeq) picked = key;
    }
    if (picked === undefined) {
      if (keys.length > 0 && keys[0] === 0) return this.loadManifest(sessionId, 0, cwdHint);
      return undefined;
    }
    return this.loadManifest(sessionId, picked, cwdHint);
  }

  /**
   * 目标状态 + 覆盖率诊断。
   *
   * 清单只在 turn/end 落盘；如果某个 turn/end 的清单丢了（进程退出、cwd 未
   * 注册、写盘失败），stateAt 会静默退化到更早的清单，plan 便把所有中间变化
   * 判成「新建产物」删掉 —— 用户会看到一堆莫名其妙的删除项。
   * 这里把「目标 seq 之前最后一轮的清单 key」和「实际可用的清单」一起返回，
   * 让调用方能判断覆盖率并给出提示。
   *
   * @returns {Promise<{manifest: object|undefined, pickedKey: number|undefined, complete: boolean}>}
   */
  async stateAtDetailed(sessionId, targetSeq, turnStarts, cwdHint) {
    const keys = await this.listManifestKeys(sessionId);
    let picked;
    for (const key of keys) {
      if (key < targetSeq) picked = key;
    }
    // 覆盖率：targetSeq 之前最后一个「轮次起点」应当是 pickedKey。
    // 对不上说明中间有轮次的清单没落盘（cwd 竞态、进程退出、写盘失败），
    // 此时文件视图会退化到更早的时间点，绝不能按「清单里没有=新建」来删文件。
    let complete = true;
    if (Array.isArray(turnStarts) && turnStarts.length > 0) {
      const expected = turnStarts.filter((seq) => seq < targetSeq).sort((a, b) => a - b).pop();
      if (expected !== undefined && picked !== undefined && expected !== picked) complete = false;
      if (expected !== undefined && picked === undefined) complete = false;
    }
    if (picked === undefined) {
      if (keys.length > 0 && keys[0] === 0) {
        return { manifest: await this.loadManifest(sessionId, 0, cwdHint), pickedKey: 0, complete };
      }
      return { manifest: undefined, pickedKey: undefined, complete };
    }
    return { manifest: await this.loadManifest(sessionId, picked, cwdHint), pickedKey: picked, complete };
  }

  /**
   * 内容寻址 blob 的绝对路径。hash 来自清单（不受信任输入）：不是 64 位 hex
   * 一律拒绝，绝不允许 `../../secret.txt` 这类注入被拼进 blob 目录。
   *
   * 读取路径：先查全局仓 `<root>/_blobs/xx/<hash>`，再回退到旧版每会话目录
   * `<root>/<sid>/artifacts/blobs/<hash>`。迁移（compact）完成后旧目录会被清掉，
   * 但在那之前用户装的旧数据必须仍能还原 —— 这条回退是兼容性的关键。
   *
   * @returns {Promise<string|undefined>}
   */
  async blobPath(sessionId, hash) {
    if (typeof hash !== 'string' || !BLOB_NAME.test(hash)) {
      this.warn(`refusing a non-content-addressed blob name: ${String(hash).slice(0, 32)}`);
      return undefined;
    }
    return (await this.blobs.ensureLocal(sessionId, hash)) ?? undefined;
  }

  /**
   * 把文件内容写进**全局**内容寻址缓存；超过上限或读不到则返回 null。
   *
   * 先 copyFile 到会话目录下的临时文件（与工作区可能跨盘，避免直接读时出现
   * EXDEV），算完 sha256 后交给 BlobStore 原子 rename 进全局仓；全局已有同内容
   * 则直接丢掉临时文件，一份字节全机只存一次。
   */
  async cacheContent(sessionId, absPath, size) {
    if (!Number.isFinite(this.maxFileBytes) || this.maxFileBytes <= 0) return null;
    if (size > this.maxFileBytes) return null;
    const tmpDir = this.blobsDir(sessionId);
    const tmp = join(tmpDir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
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
    const result = await this.blobs.putFromTemp(tmp, hash);
    if (!result.ok) {
      // putFromTemp 失败时已尽力清掉 tmp；再兜一次，避免残留。
      await rm(tmp, { force: true }).catch(() => undefined);
      if (result.reason !== 'hash-mismatch') {
        this.warn(`global blob store rejected ${hash.slice(0, 12)}: ${result.reason}`);
      }
      return null;
    }
    return hash;
  }

  /**
   * 记录一次边界状态。keySeq = 该回合起始的用户消息 seq
   * （清单语义是“这一回合跑完之后的工作区状态”）。
   *
   * 同时更新**归属账本**：与上一份清单相比「变了/新出现/消失」的路径，就是
   * 本回合本会话动过的路径。只认那些「当前字节没有被别的会话声称」的路径 ——
   * 两个会话同时改同一个文件时，谁都别把它当成自己的产物。
   */
  async record(sessionId, keySeq, cwdHint) {
    // cwd 兜底：artifactCwds 的注册发生在 agent/created 的异步 IIFE 里
    // （assertKnownStoreVersion / reconcileFormatVersion 都有 IO），而 turn/end
    // 的 handler 是同步调用。首个 turn/end 完全可能早于注册完成 —— 早先这里
    // 直接 warn + return undefined，于是整轮清单静默丢失，回退时只能退化到更
    // 早的清单，把中间所有文件变化误判成「新建产物」删掉。
    // 调用方现在会把 session.header.cwd 作为兜底传进来。
    const cwdRaw = this.cwdOf(sessionId) ?? cwdHint;
    if (cwdRaw === undefined) {
      this.warn(`no workspace directory for ${sessionId}; artifact tracking skipped`);
      return undefined;
    }
    const cwd = await normalizeCwd(cwdRaw);
    if (cwd === undefined) {
      this.warn(`cannot resolve workspace directory for ${sessionId}; artifact tracking skipped`);
      return undefined;
    }
    const keys = await this.listManifestKeys(sessionId);
    const prevKey = [...keys].reverse().find((key) => key <= keySeq);
    const prev = prevKey === undefined ? undefined : await this.loadManifest(sessionId, prevKey, cwd);
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
      const hash = await this.cacheContent(sessionId, resolveContained(cwd, rel) ?? '', info.size);
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
    await this.updateOwnedFromBoundary(sessionId, cwd, prev, files);
    await this.pruneManifests(sessionId, keySeq);
    return { key: keySeq, files: current.size, cached };
  }

  /**
   * 把「这一回合的差异」写进归属账本。
   * prev 是上一份清单（本会话自己的视图），files 是当前扫描结果。
   * 新出现 / (size,mtime) 变了 / 消失 的路径都算本会话动过；其中「别的会话
   * 账本已经声称了当前这份哈希」的路径不记 —— 那是别人的字节，记了会让本会话
   * 在回退时误以为自己是最后写入者。
   */
  async updateOwnedFromBoundary(sessionId, cwd, prev, files) {
    const owned = (await this.readOwned(sessionId)) ?? { cwd, files: Object.create(null) };
    if (owned.cwd !== undefined && owned.cwd !== cwd) owned.files = Object.create(null);
    const prevFiles = prev?.files ?? {};
    const claimed = [];
    for (const [rel, entry] of Object.entries(files)) {
      const before = prevFiles[rel];
      const changed =
        before === undefined || before[0] !== entry[0] || before[1] !== entry[1];
      if (!changed) continue;
      claimed.push([rel, entry[2] ?? UNKNOWN_HASH]);
    }
    for (const rel of Object.keys(prevFiles)) {
      if (files[rel] === undefined) claimed.push([rel, null]);
    }
    if (claimed.length === 0) return;
    // 排除别的会话已经声称同一份字节的路径（并发写入的归属歧义）。
    const selfDir = sanitizeId(sessionId);
    let roots = [];
    try {
      roots = await readdir(this.rootOf(), { withFileTypes: true });
    } catch {
      roots = [];
    }
    for (const [rel, hash] of claimed) {
      let disputed = false;
      for (const dirent of roots) {
        if (!dirent.isDirectory() || dirent.name === selfDir) continue;
        const other = await this.readOwned(dirent.name);
        if (other === undefined) continue;
        if (other.cwd !== undefined && (await normalizeCwd(other.cwd)) !== cwd) continue;
        const theirs = other.files[rel];
        if (theirs === undefined) continue;
        // 有哈希时可精确比较；没有哈希（超大文件）时只要别人也记过这个路径
        // 就无法排除归属歧义 —— 一律不记成自己的。
        if (hash === UNKNOWN_HASH || theirs === UNKNOWN_HASH || theirs === hash) {
          disputed = true;
          break;
        }
      }
      if (disputed) {
        delete owned.files[rel];
        continue;
      }
      owned.files[rel] = hash;
    }
    await this.writeOwned(sessionId, cwd, owned.files);
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
   * 回收不再被任何清单引用的内容缓存（**全局可达性**）。
   *
   * 旧实现只看本会话的清单，于是全局仓里「被别的会话引用」的 blob 会被这个会话
   * 误删 —— 迁移到共享仓后必须改成扫描根目录下**所有会话**的清单。
   * 另外顺手清掉旧版每会话 blobs/ 目录里的 `.tmp-*` 残留（旧数据不再写入，
   * 但历史残留仍占空间）。
   *
   * 只删「内容寻址文件名（64hex）」或 `.tmp-` 临时文件：blobs 目录里出现任何
   * 别的名字都说明它不归本模块管（早期实现对「不在 live 集合里的任意文件名」
   * 直接 rm，属于越权删除）。
   */
  async collectGarbage(sessionId) {
    // 1) 收集整个快照根下所有会话、所有存活清单引用的哈希。
    const live = new Set();
    let roots = [];
    try {
      roots = await readdir(this.rootOf(), { withFileTypes: true });
    } catch {
      roots = [];
    }
    for (const dirent of roots) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === '_blobs') continue;
      for (const key of await this.listManifestKeys(dirent.name)) {
        const manifest = await this.loadManifest(dirent.name, key);
        for (const entry of Object.values(manifest?.files ?? {})) {
          const hash = entry?.[2];
          if (typeof hash === 'string' && BLOB_NAME.test(hash)) live.add(hash);
        }
      }
    }
    // 2) 全局仓按可达性回收（BlobStore 内部只删 64hex / .tmp-，且受 maxDeleteBytes 限制）。
    const report = await this.blobs.collectGarbage(live, { maxDeleteBytes: 2 * 1024 * 1024 * 1024 });
    // 3) 旧版会话目录里的 .tmp- 残留：只清临时文件，保留 64hex 旧 blob（迁移由 compact 负责）。
    let legacyTmp = 0;
    for (const dirent of roots) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === '_blobs') continue;
      let names;
      try {
        names = await readdir(join(this.rootOf(), dirent.name, 'artifacts', 'blobs'));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('.tmp-')) continue;
        await rm(join(this.rootOf(), dirent.name, 'artifacts', 'blobs', name), { force: true }).catch(() => undefined);
        legacyTmp++;
      }
    }
    return { ...report, legacyTmp, live: live.size };
  }

  /** 会话刚建立时的基线（key 0）：只记录存在性，默认不缓存内容。 */
  async ensureBaseline(sessionId) {
    const keys = await this.listManifestKeys(sessionId);
    if (keys.includes(0)) return;
    return this.enqueue(sessionId, async () => {
      const cwdRaw = this.cwdOf(sessionId);
      if (cwdRaw === undefined) return;
      const cwd = await normalizeCwd(cwdRaw);
      if (cwd === undefined) return;
      const current = await walkWorkspace(cwd, this.exclude);
      const files = {};
      for (const [rel, info] of current) {
        let hash = null;
        if (this.baselineContent) {
          hash = await this.cacheContent(sessionId, resolveContained(cwd, rel) ?? '', info.size);
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
      // 基线里的文件都是「本会话开始之前就存在」的：本会话没有任何归属。
      const owned = await this.readOwned(sessionId);
      if (owned === undefined) await this.writeOwned(sessionId, cwd, Object.create(null));
    });
  }

  /** 回合结束时记一份清单。cwdHint 用于注册竞态时的兜底（见 record）。 */
  async onTurnEnd(sessionId, keySeq, cwdHint) {
    return this.enqueue(sessionId, () => this.record(sessionId, keySeq, cwdHint));
  }

  /**
   * 重新生成前的产物预快照：把当前工作区状态记成一份带负数 key 的清单，
   * 与正常边界清单走同一存储与回收机制。返回给回退结果的一段提示文字
   * （列出本轮有多少产物会被重新生成的影响面覆盖），无产物时返回空串。
   * @returns {Promise<string>} 提示文字，如 "（产物预快照 12 个文件：版本可追溯）"
   */
  async recordSnapshotForRegenerate(sessionId, targetSeq) {
    const cwdRaw = this.cwdOf(sessionId);
    if (cwdRaw === undefined) return '';
    const cwd = await normalizeCwd(cwdRaw);
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
    if (blob === undefined) return false;
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
   * 同一工作区里**其他会话**的清单是否记录了该路径的某个哈希。
   *
   * 这是**旧数据（没有 owned.json 账本）**的降级判据：旧实现用 (size, mtime) +
   * wall-clock 比较，两条都不可靠。这里只问一个不需要时钟的问题 ——
   * 「别的会话的清单里，这个路径出现过哪些内容哈希？」：
   *   - 别的会话记录过与**当前磁盘**相同的哈希 → 当前这份字节是别人写的；
   *   - 别的会话记录过与**本会话目标状态**相同的哈希 → 双方一致，无害。
   * 比较 cwd 时先规范化（尾斜杠/大小写/符号链接都归一）；缺 cwd 的清单按
   * 「未知」保守参与比较（只会多判 foreign，不会误伤）。
   *
   * @returns {Promise<Map<string, 'other'|'agree'>>} rel → 判定
   */
  async foreignTouchedPaths(sessionId, entries, sinceAt, cwdRaw) {
    const cwd = await normalizeCwd(cwdRaw);
    const verdicts = new Map();
    let roots;
    try {
      roots = await readdir(this.rootOf(), { withFileTypes: true });
    } catch (error) {
      // 旧实现这里静默 catch 返回空集，等于「检测失败 = 没有 foreign」，
      // 然后 fallback 还谎报 coverage ok。现在把失败抛给调用方，由它保守处理。
      throw new Error(`foreign-session scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const selfDir = sanitizeId(sessionId);
    for (const dirent of roots) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name === selfDir) continue;
      const otherId = dirent.name;
      let keys;
      try {
        keys = await this.listManifestKeys(otherId);
      } catch {
        continue;
      }
      for (const key of keys) {
        let manifest;
        try {
          manifest = await this.loadManifest(otherId, key, cwd);
        } catch {
          continue;
        }
        if (manifest === undefined) continue;
        // cwd 不同意味着完全不相干的项目；缺 cwd 的旧清单保守参与。
        if (manifest.cwd !== undefined && cwd !== undefined) {
          const otherCwd = await normalizeCwd(manifest.cwd);
          if (otherCwd !== cwd) continue;
        }
        for (const [rel, mine] of entries) {
          if (verdicts.has(rel)) continue;
          const theirs = manifest.files?.[rel];
          if (theirs === undefined) continue;
          const theirHash = theirs[2] ?? null;
          const myHash = Array.isArray(mine) ? (mine[2] ?? null) : null;
          // 只有哈希可比较时才能下结论；两边都没有哈希（超大文件）→ 不下结论。
          if (theirHash !== null && myHash !== null) {
            if (theirHash !== myHash) verdicts.set(rel, 'other');
            else verdicts.set(rel, 'agree');
          }
        }
      }
    }
    return verdicts;
  }

  /**
   * 计划一次回退：目标状态 vs 当前磁盘。
   *
   * 安全模型见文件头。简化成两条：
   *   1. 只对「当前磁盘字节可证明是本会话写的」路径动手（账本哈希 === 磁盘哈希）；
   *   2. 任何证据不足的情形一律 skipped，理由如实回报（不再静默）。
   *
   * @param {object} [opts]
   * @param {object} [opts.manifest] 调用方已算好的目标清单（避免 preview→restore
   *   之间重复扫描；TOCTOU 由 restore 内的二次校验兜住）
   */
  async plan(sessionId, targetSeq, turnStarts, opts = {}) {
    const cwdRaw = this.cwdOf(sessionId);
    if (cwdRaw === undefined) return { actions: [], skipped: [], cwd: undefined, coverage: 'no-cwd' };
    const cwd = await normalizeCwd(cwdRaw);
    if (cwd === undefined) return { actions: [], skipped: [], cwd: undefined, coverage: 'no-cwd' };
    const detail = opts.detail ?? (await this.stateAtDetailed(sessionId, targetSeq, turnStarts, cwd));
    const target = opts.manifest ?? detail.manifest;
    const pickedKey = detail.pickedKey;
    let complete = detail.complete;
    if (target === undefined) return { actions: [], skipped: [], cwd, coverage: 'no-manifest', pickedKey };
    // 目标清单属于**另一个工作区**（cwd 规范化后不同）：这份清单描述的不是
    // 当前工作区，按它对齐磁盘会乱动文件。直接放弃，理由如实回报。
    if (target.cwd !== undefined) {
      const targetCwd = await normalizeCwd(target.cwd);
      if (targetCwd !== cwd) {
        return { actions: [], skipped: [], cwd, coverage: 'cwd-mismatch', pickedKey };
      }
    }
    let current;
    try {
      current = await walkWorkspace(cwd, this.exclude);
    } catch (error) {
      // 扫描失败（深度/数量上限、权限）：不知道磁盘现状就绝不能按清单删文件。
      this.warn(`workspace scan failed, no files will be touched: ${error instanceof Error ? error.message : String(error)}`);
      return { actions: [], skipped: [], cwd, coverage: 'scan-failed', pickedKey };
    }
    const actions = [];
    const skipped = [];
    // 判定「新建产物」的时间下界 = 目标清单的拍摄时刻，**仅在清单链断裂时启用**。
    //
    // 正常情况下（complete=true，每轮清单都在），按「清单里没有 = 回退点之后新建」
    // 严格判定 —— 这正是用户要的累积回退语义：回退第 1 句，第 2/3 句产生的产物
    // 一起撤掉，哪怕它的 mtime 因 cp -p 之类的原因显得很旧。
    //
    // 但清单只在 turn/end 落盘，一旦某轮丢了（cwd 未注册的竞态、进程退出、写盘
    // 失败），stateAt 会退化到几小时前的旧清单。那时「清单里没有、磁盘上有」的
    // 文件里混着大量与回退点无关的历史文件，全判 created 会把工作区掏空 ——
    // 实测一次回退列出了 5 个无关的测试文件等待删除。
    // 这条链一旦断裂就转为保守策略：只处理 mtime 晚于清单时刻的文件，
    // 更早的一律跳过（宁可少删，不能误删）。
    //
    // 没有 turnStarts 时用 mtime 自检兜底：清单未记录的文件里只要出现「早于清单
    // 拍摄时刻」的，就说明清单漏记过 —— 真实新建的文件不可能早于记录它的快照。
    // 此时同样降级为保守策略。
    if (complete && Number.isFinite(target.at)) {
      for (const [rel, info] of current) {
        if (Object.hasOwn(target.files, rel)) continue;
        if (info.mtime < target.at) {
          complete = false;
          break;
        }
      }
    }
    const boundaryAt = complete ? undefined : (Number.isFinite(target.at) ? target.at : undefined);
    const rels = new Set([...Object.keys(target.files), ...current.keys()]);
    // 归属账本 + 别的会话清单里的哈希，两条证据**都**要查。
    //
    // 只靠账本会漏掉一类真实事故：会话 B 在某个文件已经存在之后才建基线，
    // `ensureBaseline` 把「基线里已有」一律视为「B 开始之前就存在」而不记账；
    // 若 B 随后改了它、但改动在 B 自己落盘基线之前完成，B 的账本里根本没有
    // 这个路径 → A 的账本也查不到别人的声称 → A 的回退把 B 的改动还原掉。
    // 清单是「整个工作区某时刻的样子」，恰好能补上这一条：别的会话清单里
    // 记过与当前磁盘不同/与 A 目标不同的哈希，就说明这路径被别人动过。
    const owned = await this.readOwned(sessionId);
    const legacyEntries = new Map();
    for (const rel of rels) {
      const before = target.files[rel];
      legacyEntries.set(rel, before === undefined ? null : before);
    }
    let legacyForeign;
    try {
      legacyForeign = await this.foreignTouchedPaths(sessionId, legacyEntries, target.at, cwd);
    } catch (error) {
      // 检测失败：旧实现这里会「假装没有 foreign」并继续删文件。现在一律不动。
      this.warn(`foreign-session guard failed, no files will be touched: ${error instanceof Error ? error.message : String(error)}`);
      return {
        actions: [],
        skipped: [...rels].map((rel) => ({ rel, reason: 'foreign-check-failed' })),
        cwd,
        coverage: 'foreign-check-failed',
        pickedKey,
      };
    }
    // 每个候选的「当前磁盘哈希」按需计算并缓存（同一路径只算一次）。
    const diskHashCache = new Map();
    // 其他会话账本的快照缓存（同一次 plan 内只遍历一次快照根目录）。
    // 没有它时 ownershipFor 会为每个候选路径重扫全部会话目录：44 个会话 ×
    // 157 个路径 ≈ 20 秒，远超前端 8 秒预算（截图 image-23 的超时）。
    const ledgerCache = new Map();
    const diskHashOf = async (rel) => {
      if (diskHashCache.has(rel)) return diskHashCache.get(rel);
      const abs = resolveContained(cwd, rel);
      let hash = null;
      if (abs !== undefined) {
        try {
          hash = await sha256File(abs);
        } catch {
          hash = null;
        }
      }
      diskHashCache.set(rel, hash);
      return hash;
    };
    // 归属判定：账本（内容哈希）为主，别的会话清单哈希作为**并行的第二条证据**。
    // 任一判据说「这是别人的字节」就跳过 —— 这正是 AUDIT.md P0-1 要求的
    // 「不能只靠最窄的那条路径」。
    const verdictOf = async (rel, diskHash, targetEntry, verdictOpts) => {
      // 别的会话的清单记录过这个路径、且记录的哈希与本会话目标状态不同 →
      // 这条路径在目标时刻之后被别的会话写过，绝不能由本次回退替它做主。
      // 注意：两边哈希一致（agree）是无害的，不算 foreign。
      if (legacyForeign?.get(rel) === 'other') return 'other';
      if (owned !== undefined) {
        const verdict = await this.lastWriterVerdict(sessionId, rel, cwd, diskHash, { ...verdictOpts, ledgerCache });
        // 清单链断裂（coverage=stale）时的兜底：目标清单里没有、mtime 又明显
        // 晚于清单拍摄时刻的文件，极可能是本会话在「清单丢失的那几轮」里新建
        // 的产物。此时账本里没有它是因为那几轮的 turn/end 压根没落盘，不是
        // 别的会话写的。只要没有别的会话声称过这个路径，就按「自有产物」放行 ——
        // 否则真实事故里「清单丢了几轮」会导致所有新产物都判 unowned、回退化成
        // 空转（实测回归用例 5）。严格模式（complete=true）不走这条兜底，
        // 保持「账本没记录就绝不动」的强不变量。
        if (verdict === 'unknown' && !complete && verdictOpts?.allowUnverified === true) {
          const now = current.get(rel);
          if (
            now !== undefined &&
            Number.isFinite(target.at) &&
            now.mtime >= target.at &&
            owned?.files?.[rel] === undefined
          ) {
            const { others } = await this.ownershipFor(sessionId, rel, cwd, ledgerCache);
            if (others.length === 0) return 'self-unverified';
          }
        }
        return verdict;
      }
      const legacy = legacyForeign?.get(rel);
      if (legacy === 'other') return 'other';
      // 没有账本：只有「别的会话记录过与磁盘相同的哈希」才判 foreign。
      // 其余情况按旧行为放行（否则所有升级用户的第一次回退都会变成空转）。
      return 'legacy-ok';
    };
    for (const rel of rels) {
      const before = target.files[rel];
      const now = current.get(rel);
      const abs = resolveContained(cwd, rel);
      if (abs === undefined) {
        // 非法 rel（投毒清单）：绝不"尽力还原"，如实跳过。
        skipped.push({ rel, reason: 'unsafe-path' });
        continue;
      }
      if (now === undefined) {
        // 目标时刻存在、现在不存在 → 需要还原（前提是有内容备份）。
        if (before === undefined) continue;
        const hash = before[2] ?? null;
        if (hash === null) {
          skipped.push({ rel, reason: 'missing-no-backup' });
          continue;
        }
        const blob = await this.blobPath(sessionId, hash);
        const backupReady = blob !== undefined && (await exists(blob));
        if (!backupReady) {
          skipped.push({ rel, reason: 'missing-no-backup' });
          continue;
        }
        // 缺失状态的归属：只有「本会话账本记着这个路径已被删除（null）」才允许
        // 复活它 —— 否则可能是别的会话删的，替别人复活等于制造幽灵文件。
        if (owned !== undefined) {
          const { mine, others } = await this.ownershipFor(sessionId, rel, cwd, ledgerCache);
          if (mine !== null || others.length > 0) {
            skipped.push({ rel, reason: mine === null ? 'foreign-session' : 'deleted-by-other' });
            continue;
          }
        } else if (legacyForeign?.get(rel) === 'other') {
          skipped.push({ rel, reason: 'foreign-session' });
          continue;
        }
        actions.push({ rel, action: 'restore', hash });
        continue;
      }
      const diskHash = await diskHashOf(rel);
      if (before === undefined) {
        // 目标时刻不存在、现在存在 → 本会话新建的产物，移入隔离区。
        if (boundaryAt !== undefined && now.mtime < boundaryAt) {
          skipped.push({ rel, reason: 'predates-manifest' });
          continue;
        }
        const verdict = await verdictOf(rel, diskHash, undefined, { allowUnverified: true });
        if (verdict === 'other' || verdict === 'ambiguous') {
          skipped.push({ rel, reason: 'foreign-session' });
          continue;
        }
        if (verdict === 'unknown') {
          // 无法证明是本会话产物 → 保守跳过（旧实现正是拿当前磁盘状态冒充
          // 目标状态去和别人的清单比，于是永远判不出 foreign）。
          skipped.push({ rel, reason: 'unowned' });
          continue;
        }
        actions.push({ rel, action: 'delete', reason: 'created' });
        continue;
      }
      const hash = before[2] ?? null;
      const backupReady = hash !== null && (await exists(await this.blobPath(sessionId, hash)));
      // Exact mtime comparison: a tolerance here would report "unchanged" for a
      // same-size rewrite made right after the boundary was recorded. 但 size+mtime
      // 相同也可能内容不同（cp -p / 编辑器保 mtime），所以有哈希时以哈希为准。
      let changed = now.size !== before[0] || now.mtime !== before[1];
      if (!changed && hash !== null && diskHash !== null && diskHash !== hash) changed = true;
      if (!changed) continue;
      if (backupReady) {
        const verdict = await verdictOf(rel, diskHash, before, { allowUnverified: true });
        if (verdict === 'other' || verdict === 'ambiguous') {
          skipped.push({ rel, reason: 'foreign-session' });
          continue;
        }
        if (verdict === 'unknown') {
          // 现状不是本会话写的（账本里没有对得上的哈希）：可能是别人改的、
          // 也可能是用户手工改的 —— 两种情况都不该由这次回退替他们做主。
          skipped.push({ rel, reason: 'unowned' });
          continue;
        }
        actions.push({ rel, action: 'restore', hash });
      } else {
        // The file EXISTED at the target state, but its content was never cached
        // (over the cap, or unreadable). We cannot know what it held then, so we
        // must not move it: that would make a file the user still has disappear
        // from the worktree. Leave it in place and report it as skipped instead.
        skipped.push({ rel, reason: 'changed-no-backup' });
      }
    }
    return { actions, skipped, cwd, coverage: complete ? 'ok' : 'stale', pickedKey, owned };
  }

  /**
   * 把旧版每会话 blobs/ 里的历史数据收编进全局仓（`/snapshot-auto-cleanup compact`）。
   *
   * 对每个 64hex 文件：全局已有同内容 → 直接删掉这份会话副本（真释放空间）；
   * 全局没有 → 硬链接收编（同卷瞬时完成，之后删会话副本才真正释放重复字节）。
   * 任何一步哈希校验失败都跳过该文件并告警，绝不拿损坏的字节污染全局仓。
   *
   * @param {object} opts
   * @param {boolean} [opts.dryRun] 只统计不改盘
   * @param {number} [opts.maxBytes] 本轮最多释放多少字节（防止一次跑太久）
   * @returns {Promise<{adopted:number, deduped:number, bytes:number, skipped:number, remains:number, dryRun:boolean}>}
   */
  async compactIntoGlobal(opts = {}) {
    const dryRun = opts.dryRun === true;
    const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(0, opts.maxBytes) : Infinity;
    let roots = [];
    try {
      roots = await readdir(this.rootOf(), { withFileTypes: true });
    } catch {
      roots = [];
    }
    const result = { adopted: 0, deduped: 0, bytes: 0, skipped: 0, remains: 0, dryRun };
    if (!dryRun) await this.blobs.init();
    for (const dirent of roots) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === '_blobs') continue;
      let legacy;
      try {
        legacy = await this.blobs.listLegacy(dirent.name);
      } catch {
        continue;
      }
      for (const item of legacy) {
        if (result.bytes >= maxBytes) {
          result.remains++;
          continue;
        }
        // adopt() 自己会判断「全局是否已有同内容」并复核旧 blob 完整性：
        //  - already-global / would-adopt(预演时全局已有) → 这份会话副本是纯重复，
        //    删掉即真正释放 reclaimed 字节；
        //  - adopted / would-adopt(全局没有) → 硬链接收编进全局仓，删掉会话副本后
        //    字节数不变，只是从「每会话一份」变成「全机一份」。
        const adopt = await this.blobs.adopt(dirent.name, item.name, { dryRun });
        if (!adopt.ok) {
          result.skipped++;
          this.warn(`compact skipped ${item.name.slice(0, 12)}: ${adopt.reason}`);
          continue;
        }
        const isPureDuplicate = adopt.action === 'already-global';
        if (isPureDuplicate) {
          if (!dryRun) result.bytes += await this.blobs.unlinkLegacy(dirent.name, item.name);
          else result.bytes += item.size;
          result.deduped++;
        } else {
          // 收编：字节不变（全局仓多一份，会话删一份）。
          if (!dryRun) await this.blobs.unlinkLegacy(dirent.name, item.name);
          result.adopted++;
        }
      }
    }
    return result;
  }

  /** 供宿主侧配额命令读取全局仓占用。 */
  async globalBlobStats() {
    return this.blobs.stats();
  }

  /** 供宿主侧配额命令做全局可达性回收（返回 BlobStore 的回收报告）。 */
  async globalCollectGarbage(opts = {}) {
    const live = new Set();
    let roots = [];
    try {
      roots = await readdir(this.rootOf(), { withFileTypes: true });
    } catch {
      roots = [];
    }
    for (const dirent of roots) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === '_blobs') continue;
      for (const key of await this.listManifestKeys(dirent.name)) {
        const manifest = await this.loadManifest(dirent.name, key);
        for (const entry of Object.values(manifest?.files ?? {})) {
          const hash = entry?.[2];
          if (typeof hash === 'string' && BLOB_NAME.test(hash)) live.add(hash);
        }
      }
    }
    return this.blobs.collectGarbage(live, opts);
  }

  /** 供 popover 的影响清单使用：{ path, action }[]。 */
  async preview(sessionId, targetSeq, turnStarts) {
    const { actions, cwd } = await this.plan(sessionId, targetSeq, turnStarts);
    if (cwd === undefined) return [];
    return actions
      .map((item) => ({ path: join(cwd, ...item.rel.split('/')), action: item.action === 'restore' ? 'restore' : 'delete' }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 执行回退：能还原的还原字节，不能还原的移入隔离区（不硬删）。
   *
   * 每个 action 执行前做**二次校验**（TOCTOU）：preview/plan 与真正落盘之间
   * 别的会话可能又写了一次；只有「现在这份字节仍可证明是本会话写的」才动。
   *
   * @param {object} [opts]
   * @param {object} [opts.plan] 调用方已算好的计划（避免 preview→restore 重复扫描）
   */
  async restore(sessionId, targetSeq, markerSeq, turnStarts, opts = {}) {
    const summary = {
      restored: 0,
      quarantine: 0,
      skipped: 0,
      failed: 0,
      dir: undefined,
      errors: [],
      restoredPaths: [],
      quarantinedPaths: [],
      coverage: 'ok',
    };
    const planned = opts.plan ?? (await this.plan(sessionId, targetSeq, turnStarts));
    const { actions, skipped, cwd, coverage } = planned;
    summary.skipped = skipped.length;
    summary.coverage = coverage;
    if (cwd === undefined || actions.length === 0) {
      if (cwd !== undefined) await this.finishRestore(sessionId, targetSeq, markerSeq, cwd, summary);
      return summary;
    }
    const owned = planned.owned ?? (await this.readOwned(sessionId));
    // 与 plan() 同理：recheck 对每个 action 都要调 ownershipFor，缓存一次
    // 遍历结果，避免 O(actions × sessions) 的重复读盘。
    const ledgerCache = new Map();
    const opId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const qRoot = join(this.quarantineDir(sessionId), opId);
    summary.dir = qRoot;
    const index = [];
    // 还原前先创建隔离区：任何失败路径都不该让"被移出的内容"没有去处
    await mkdir(qRoot, { recursive: true }).catch(() => undefined);
    for (const item of actions) {
      const abs = resolveContained(cwd, item.rel);
      if (abs === undefined) {
        summary.skipped++;
        summary.errors.push(`${item.rel}: unsafe path, not touched`);
        continue;
      }
      try {
        // ── TOCTOU 二次校验：现状必须仍可证明是本会话写的 ────────────────
        const info = await lstat(abs).catch(() => undefined);
        const recheck = async () => {
          if (owned === undefined) return 'legacy-ok';
          const { mine, others } = await this.ownershipFor(sessionId, item.rel, cwd, ledgerCache);
          if (info === undefined) {
            // 当前已不存在：只有本会话删过（账本 null）才允许"还原/确认不存在"。
            return mine === null && others.length === 0 ? 'self' : 'unknown';
          }
          let diskHash = null;
          if (info.isFile()) {
            try {
              diskHash = await sha256File(abs);
            } catch {
              diskHash = null;
            }
          }
          // 目标位置变成目录（或任何非普通文件）：本会话把文件删了换成目录
          // 时账本记的是 null，此时现状仍是本会话造成的，允许还原流程先把
          // 整个目录移进隔离区（保数据）再写回文件。
          if (typeof diskHash !== 'string' && mine === null && others.length === 0) return 'self';
          // 别的会话声称了当前这份字节 → 归属有歧义，一律不动。
          if (typeof diskHash === 'string' && others.some((hash) => hash === diskHash)) {
            return mine === diskHash ? 'ambiguous' : 'other';
          }
          if (typeof diskHash === 'string' && mine === diskHash) return 'self';
          // 超上限文件的账本值是 UNKNOWN_HASH（'?'）而不是内容哈希。隔离动作
          // 只是移走字节、不销毁，plan() 对它放行（allowUnverified），这里必须
          // 用同一套判定，否则「目标时刻不存在、后来新建的大文件」会恒判
          // unknown、隔离区为空（实测回归用例 1b）。还原动作不覆盖目标字节，
          // 因此只有 delete/quarantine 才接受这个未验证的自有产物。
          if (item.action === 'delete' && mine === UNKNOWN_HASH && others.length === 0) {
            return 'self-unverified';
          }
          return 'unknown';
        };
        const verdict = await recheck();
        if (verdict !== 'self' && verdict !== 'self-unverified' && verdict !== 'legacy-ok') {
          summary.skipped++;
          summary.errors.push(`${item.rel}: changed by another session since the plan was made, not touched`);
          continue;
        }
        if (item.action === 'restore') {
          const blob = await this.blobPath(sessionId, item.hash);
          if (blob === undefined || !(await exists(blob))) {
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
    // index.json 是隔离物的**唯一去向索引**：写失败必须 loud，且不能假装成功。
    // 即使写失败，隔离区目录布局仍镜像原工作区路径（qRoot/<rel>），数据可人工找回。
    if (index.length > 0) {
      try {
        await writeJsonAtomic(join(qRoot, 'index.json'), {
          sessionId,
          targetSeq,
          markerSeq,
          at: Date.now(),
          items: index,
        });
      } catch (error) {
        summary.failed++;
        const message = `quarantine index.json write failed: ${error instanceof Error ? error.message : String(error)}`;
        summary.errors.push(`${message}; quarantined content is at ${qRoot} (layout mirrors the workspace)`);
        this.warn(`${message} (session ${sessionId}, op ${opId})`);
      }
    }
    await this.collectLeftoverTmp(sessionId, cwd);
    await this.finishRestore(sessionId, targetSeq, markerSeq, cwd, summary);
    return summary;
  }

  /**
   * 把一个路径（文件或整棵目录树）移入本次还原的隔离区。
   * 返回 { count, paths, index }；无法安全移动时返回 undefined（调用方计 failed）。
   * 目录会被**整棵移动**，而不是逐个文件隔离 —— 避免出现"目录被移走一半"的中间状态。
   *
   * 顺序：优先 `rename`（同设备原子移动，源一旦消失就已经在隔离区里）；
   * 跨设备时退化为「copy 到隔离区 → 校验 size 与 sha256 → 才 unlink 源」。
   * 旧实现在 copy 成功后无条件 rm 源，copy 半份/校验失败也会删掉源（数据丢失）。
   */
  async quarantinePath(sessionId, opId, cwd, rel, info) {
    const abs = resolveContained(cwd, rel);
    if (abs === undefined) return undefined;
    const dest = join(this.quarantineDir(sessionId), opId, ...rel.split('/'));
    const paths = [];
    const index = [];
    await mkdir(dirname(dest), { recursive: true });
    let movedByRename = false;
    try {
      await rename(abs, dest);
      movedByRename = true;
    } catch {
      // 跨设备或占用时的兜底：先复制到临时名，校验字节一致后才删源。
      const tmp = `${dest}.part`;
      try {
        await copyFile(abs, tmp);
        const srcSize = info?.isDirectory?.() ? undefined : info?.size;
        const copied = await stat(tmp);
        if (srcSize !== undefined && copied.size !== srcSize) {
          throw new Error(`quarantine copy size mismatch (${copied.size} != ${srcSize})`);
        }
        if (srcSize !== undefined) {
          const srcHash = await sha256File(abs);
          const copyHash = await sha256File(tmp);
          if (srcHash !== copyHash) throw new Error('quarantine copy digest mismatch');
        }
        await rename(tmp, dest);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        await rm(dest, { force: true, recursive: true }).catch(() => undefined);
        this.warn(`quarantine copy failed for ${rel}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
    // rename 分支源已经不在；copy 分支必须自己删源（此时副本已校验通过）。
    if (!movedByRename) {
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
    const stack = [{ rel: '', depth: 0 }];
    while (stack.length > 0) {
      const { rel: relDir, depth } = stack.pop();
      if (depth > MAX_SCAN_DEPTH) continue;
      const absDir = relDir === '' ? root : resolveContained(root, relDir);
      if (absDir === undefined) continue;
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
          stack.push({ rel, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const match = /^(.+)\.rewind-(\d+)\.tmp$/.exec(entry.name);
        if (match === null) continue;
        // 只清理本进程 pid 的临时文件（跨进程时可能是别人正在写的）
        if (Number(match[2]) !== process.pid) continue;
        // 同名原始文件仍存在，才说明这是"复制到一半失败"的残留
        const originalRel = relDir === '' ? match[1] : `${relDir}/${match[1]}`;
        const originalAbs = resolveContained(root, originalRel);
        if (originalAbs === undefined || !(await exists(originalAbs))) continue;
        const tmpAbs = resolveContained(root, rel);
        if (tmpAbs === undefined) continue;
        await rm(tmpAbs, { force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * 回退后收拾清单：丢掉目标之后的旧清单，按当前磁盘补一份新的，
   * 并把**本次真正落盘的改动**记进归属账本（还原 = 本会话写了目标字节；
   * 隔离 = 本会话删除了该路径）。
   */
  async finishRestore(sessionId, targetSeq, markerSeq, cwd, summary) {
    const keys = await this.listManifestKeys(sessionId);
    for (const key of keys) {
      if (key > targetSeq) await rm(this.manifestPath(sessionId, key), { force: true }).catch(() => undefined);
    }
    const owned = (await this.readOwned(sessionId)) ?? { cwd, files: Object.create(null) };
    if (owned.cwd !== undefined && owned.cwd !== cwd) owned.files = Object.create(null);
    const relOf = (abs) => toRel(cwd, abs);
    for (const abs of summary?.restoredPaths ?? []) {
      const rel = relOf(abs);
      if (rel === undefined) continue;
      try {
        owned.files[rel] = await sha256File(abs);
      } catch {
        owned.files[rel] = null;
      }
    }
    for (const abs of summary?.quarantinedPaths ?? []) {
      const rel = relOf(abs);
      if (rel === undefined) continue;
      owned.files[rel] = null;
    }
    if (!Number.isSafeInteger(markerSeq)) {
      await this.writeOwned(sessionId, cwd, owned.files).catch(() => undefined);
      return;
    }
    const target = await this.stateAt(sessionId, targetSeq, cwd);
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
    await this.writeOwned(sessionId, cwd, owned.files).catch((error) => {
      this.warn(`owned ledger write failed after restore: ${error instanceof Error ? error.message : String(error)}`);
    });
    await writeJsonAtomic(this.manifestPath(sessionId, markerSeq), {
      v: MANIFEST_VERSION,
      key: markerSeq,
      at: Date.now(),
      cwd,
      files,
    }).catch(() => undefined);
  }
}

export { DEFAULT_EXCLUDE, resolveContained, sanitizeId };
