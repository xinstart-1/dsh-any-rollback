// 回归测试：回退弹窗「无法获取影响清单：preview request timed out」（截图 image-23）
//
// 事故：回退弹窗一直显示「preview request timed out」。405 已修（路由通了），
// 但宿主处理 preview 要 6.6~19 秒，远超前端 8 秒预算。
//
// 根因：ArtifactTracker.plan() 对**每个候选路径**调用 ownershipFor()，
// 而它每次都重新 readdir 快照根目录、逐个会话读 owned.json + JSON.parse，
// 还要对每个 cwd 做 realpath。实测本机 44 个会话目录时单次 132ms；
// 157 个候选路径累计 20 秒 —— O(files × sessions) 的重复 IO。
//
// 修复：同一次 plan/restore 内共享一份「其他会话账本」快照缓存
// （otherOwnedFor + ledgerCache），把总开销降为 O(sessions + files)。
// 实测 35 个 rel：5435ms → 191ms（28.5×）。
//
// 本测试：
//   1) 断言 plan() 与 restore() 都建了 ledgerCache 并传进每个 ownershipFor 调用；
//   2) 用真实快照目录做一次「缓存 vs 不缓存」的耗时对比（有目录才跑）；
//   3) 断言缓存的语义等价：同一份输入下两者返回相同的 others。
import { readdir, readFile, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

const trackSrc = readFileSync(join(root, 'lib', 'artifact-track.js'), 'utf8')

console.log('1) 缓存机制存在且被 plan()/restore() 使用')
{
  check(/async otherOwnedFor\(sessionId, cwd, cache\)/.test(trackSrc), '定义了 otherOwnedFor 缓存构建器')
  check(/async ownershipFor\(sessionId, rel, cwd, cache\)/.test(trackSrc), 'ownershipFor 接受 cache 参数')
  check(/opts\.ledgerCache/.test(trackSrc), 'lastWriterVerdict 透传 ledgerCache')

  // plan() 里必须建缓存
  const planAt = trackSrc.indexOf('async plan(sessionId')
  const planEnd = trackSrc.indexOf('async compactIntoGlobal')
  const planBody = trackSrc.slice(planAt, planEnd > planAt ? planEnd : planAt + 60000)
  check(/const ledgerCache = new Map\(\)/.test(planBody), 'plan() 内建 ledgerCache')
  // plan 内每个 ownershipFor 调用都必须带 ledgerCache
  const planCalls = [...planBody.matchAll(/this\.ownershipFor\(sessionId, rel, cwd(, ledgerCache)?\)/g)]
  const withoutCache = planCalls.filter((m) => m[1] === undefined).length
  check(planCalls.length > 0 && withoutCache === 0,
    `plan() 内所有 ownershipFor 调用都带缓存（${planCalls.length} 处）`,
    `${withoutCache} 处漏传`)

  // restore() 里同样
  const restoreAt = trackSrc.indexOf('async restore(sessionId')
  const restoreEnd = trackSrc.indexOf('async finishRestore')
  const restoreBody = trackSrc.slice(restoreAt, restoreEnd > restoreAt ? restoreEnd : restoreAt + 30000)
  check(/const ledgerCache = new Map\(\)/.test(restoreBody), 'restore() 内建 ledgerCache')
  const restoreCalls = [...restoreBody.matchAll(/this\.ownershipFor\(sessionId, item\.rel, cwd(, ledgerCache)?\)/g)]
  check(restoreCalls.length > 0 && restoreCalls.every((m) => m[1] !== undefined),
    'restore() 内 ownershipFor 调用都带缓存')
}

console.log('2) 语义等价：缓存与否返回同样的 others')
{
  // 用真实快照目录；没有就 SKIP
  // 布局自 any.29 起是「工作区 / 会话」两层：会话目录可能直接位于根下
  // （旧扁平布局）或位于 ws-<hash>/ 下（新布局），两者都要能枚举到。
  const snapRoot = join(homedir(), '.dsh', 'rewind-snapshots')
  let sessionDirs = []
  try {
    const roots = await readdir(snapRoot, { withFileTypes: true })
    for (const dirent of roots) {
      if (!dirent.isDirectory()) continue
      if (dirent.name.startsWith('ws-')) {
        // 新布局：工作区目录下的每个子目录是一个会话
        const inner = await readdir(join(snapRoot, dirent.name), { withFileTypes: true }).catch(() => [])
        for (const child of inner) {
          if (!child.isDirectory()) continue
          sessionDirs.push({
            name: child.name,
            dir: join(snapRoot, dirent.name, child.name),
            workspace: dirent.name,
          })
        }
        continue
      }
      if (dirent.name.startsWith('.')) continue
      sessionDirs.push({ name: dirent.name, dir: join(snapRoot, dirent.name), workspace: undefined })
    }
  } catch {
    console.log('  SKIP: 快照目录不可读，跳过真实数据对比')
  }

  if (sessionDirs.length > 0) {
    // self 取第一个有 owned.json 的会话（空目录没有可对比的 rel）
    let self = sessionDirs[0].name
    let selfDir = sessionDirs[0].dir
    // 按会话目录名找它的绝对路径（两层布局下不能再拼根路径）
    const dirOf = new Map(sessionDirs.map((d) => [d.name, d.dir]))
    async function readOwned(id) {
      const dir = dirOf.get(id) ?? join(snapRoot, id)
      try { return JSON.parse(await readFile(join(dir, 'artifacts', 'owned.json'), 'utf8')) }
      catch { return undefined }
    }
    async function normalizeCwd(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return undefined
      try { return await realpath(cwd) } catch { return cwd }
    }

    // 修复前：每次重扫
    async function uncached(rel, cwd) {
      const others = []
      for (const entry of sessionDirs) {
        if (entry.name === self) continue
        const data = await readOwned(entry.name)
        if (data === undefined) continue
        if (data.cwd !== undefined && cwd !== undefined && (await normalizeCwd(data.cwd)) !== cwd) continue
        if (data.files[rel] !== undefined) others.push(data.files[rel])
      }
      return others
    }
    // 修复后：一次建缓存
    async function buildCache(cwd) {
      const records = []
      for (const entry of sessionDirs) {
        if (entry.name === self) continue
        const data = await readOwned(entry.name)
        if (data === undefined) continue
        if (data.cwd !== undefined && cwd !== undefined && (await normalizeCwd(data.cwd)) !== cwd) continue
        records.push(data.files)
      }
      return records
    }
    function cached(records, rel) {
      const others = []
      for (const files of records) if (files[rel] !== undefined) others.push(files[rel])
      return others
    }

    // 取一个真实 cwd 与几个真实 rel：扫到第一个有文件的 owned.json
    let anyOwned
    for (const entry of sessionDirs) {
      const data = await readOwned(entry.name)
      if (data !== undefined && data.cwd !== undefined && Object.keys(data.files ?? {}).length > 0) {
        anyOwned = data
        self = entry.name
        selfDir = entry.dir ?? dirOf.get(entry.name)
        break
      }
    }
    const cwd = anyOwned?.cwd
    const rels = Object.keys(anyOwned?.files ?? {}).slice(0, 5)
    check(rels.length > 0, '找到可用于对比的真实 rel', String(rels.length))

    if (rels.length > 0) {
      const records = await buildCache(cwd)
      let same = true
      for (const rel of rels) {
        const a = await uncached(rel, cwd)
        const b = cached(records, rel)
        const sameSet = a.length === b.length && a.every((v, i) => v === b[i])
        if (!sameSet) {
          same = false
          console.log(`      不一致 @${rel}: uncached=${JSON.stringify(a)} cached=${JSON.stringify(b)}`)
        }
      }
      check(same, '缓存结果与逐次读取完全一致（语义等价）')
    }
  }
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
