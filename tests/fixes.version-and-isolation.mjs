// 回归测试：本次修复的两处缺陷
//
//  1. 首次 /regen 后版本数必须 ≥2（原始版 + 重生成版），控件才会出现。
//  2. 同一工作区里别的会话改过的文件，回退不得还原/隔离（跨会话污染）。
//
// 直接跑：node tests/fixes.version-and-isolation.mjs

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactTracker } from '../lib/artifact-track.js';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function eq(name, actual, expected) {
  ok(`${name}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
    JSON.stringify(actual) === JSON.stringify(expected));
}

// ── 复刻宿主 versions 端点的版本页推导（与 lib/index.js 同算法）──────────────
function buildVersions(events) {
  const names = new Map();
  const markers = new Set();
  for (const e of events) {
    if (e.type === 'command/run' && typeof e.data?.commandId === 'string') {
      names.set(e.data.commandId, e.data.name);
      continue;
    }
    if (e.type !== 'command/done') continue;
    if (e.data?.kind !== 'success') continue;
    const marker = e.data.sourceEventSeq;
    if (!Number.isSafeInteger(marker)) continue;
    if (names.get(e.data.commandId) !== 'regen') continue;
    names.set(e.data.commandId, undefined);
    markers.add(marker);
  }
  const cite = (ev) => {
    const raw = Array.isArray(ev?.sourceEventSeqs) ? ev.sourceEventSeqs
      : Array.isArray(ev?.data?.sourceEventSeqs) ? ev.data.sourceEventSeqs : [];
    return raw.flat(Infinity).filter((s) => Number.isSafeInteger(s)).sort((a, b) => a - b);
  };
  const generations = new Map();
  for (const e of events) {
    const isMarker = e.type === 'user/message'
      && e.data?.source?.kind === 'dsh-rewind'
      && markers.has(e.seq);
    if (!isMarker) continue;
    const targetSeq = cite(e)[0];
    if (!Number.isSafeInteger(targetSeq)) continue;
    const list = generations.get(targetSeq) ?? [];
    list.push({ markerSeq: e.seq, targetSeq, startSeq: targetSeq, endSeq: targetSeq });
    generations.set(targetSeq, list);
  }
  const versions = [];
  for (const [targetSeq, list] of [...generations.entries()].sort((a, b) => a[0] - b[0])) {
    versions.push({ index: versions.length + 1, markerSeq: 0, targetSeq, original: true });
    for (const page of list.sort((a, b) => a.markerSeq - b.markerSeq)) {
      versions.push({ ...page, index: versions.length + 1, original: false });
    }
  }
  return versions;
}

console.log('1) 首次 /regen 后版本数（控件渲染门槛 versions.length >= 2）');
{
  const events = [
    { seq: 10, type: 'user/message', data: { source: { kind: 'user' } } },
    { seq: 14, type: 'assistant/message', data: {} },
    { seq: 20, type: 'command/run', data: { commandId: 'c1', name: 'regen' } },
    { seq: 42, type: 'user/message', data: { source: { kind: 'dsh-rewind' } }, sourceEventSeqs: [10, 14] },
    { seq: 43, type: 'command/done', data: { commandId: 'c1', kind: 'success', sourceEventSeq: 42 } },
  ];
  const v = buildVersions(events);
  eq('首次 regen 的版本数', v.length, 2);
  ok('第 1 版是原始版', v[0].original === true && v[0].markerSeq === 0);
  ok('第 2 版是重生成版', v[1].original === false && v[1].markerSeq === 42);
  ok('控件渲染门槛通过（>=2）', v.length >= 2);
}

console.log('2) 无 /regen 时不应凭空出现版本页');
{
  const events = [
    { seq: 10, type: 'user/message', data: { source: { kind: 'user' } } },
    { seq: 14, type: 'assistant/message', data: {} },
  ];
  eq('未 regen 的版本数', buildVersions(events).length, 0);
}

console.log('3) 两次 regen 得到 3 版');
{
  const events = [
    { seq: 10, type: 'user/message', data: { source: { kind: 'user' } } },
    { seq: 20, type: 'command/run', data: { commandId: 'c1', name: 'regen' } },
    { seq: 42, type: 'user/message', data: { source: { kind: 'dsh-rewind' } }, sourceEventSeqs: [10, 14] },
    { seq: 43, type: 'command/done', data: { commandId: 'c1', kind: 'success', sourceEventSeq: 42 } },
    { seq: 60, type: 'command/run', data: { commandId: 'c2', name: 'regen' } },
    { seq: 70, type: 'user/message', data: { source: { kind: 'dsh-rewind' } }, sourceEventSeqs: [10, 14] },
    { seq: 71, type: 'command/done', data: { commandId: 'c2', kind: 'success', sourceEventSeq: 70 } },
  ];
  const v = buildVersions(events);
  eq('两次 regen 的版本数', v.length, 3);
  ok('第一版仍是原始版', v[0].original === true);
}

console.log('4) 跨会话隔离：别的会话改过的文件不得被回退');
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-iso-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const mine = 'a.txt';
  const theirs = 'b.txt';
  await writeFile(join(ws, mine), 'AAA');
  await writeFile(join(ws, theirs), 'BBB');

  const cwds = new Map();
  const tracker = new ArtifactTracker({
    rootDir: () => join(root, 'snap'),
    cwdOf: (id) => cwds.get(id),
    maxFileBytes: 1 << 20,
    baselineContent: true,
    exclude: '',
    keepManifests: 50,
  });

  // 会话 A 建立基线并记录边界
  cwds.set('sess-A', ws);
  await tracker.ensureBaseline('sess-A');
  await tracker.onTurnEnd('sess-A', 10);

  // 会话 B 在「之后」也记录同一工作区，并改掉 b.txt（模拟另一会话编辑）
  cwds.set('sess-B', ws);
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(join(ws, theirs), 'BBB-changed-by-B-session');
  await tracker.ensureBaseline('sess-B');
  await tracker.onTurnEnd('sess-B', 20);

  // 会话 A 再改 a.txt（这是 A 自己的改动，应该能被回退）
  await writeFile(join(ws, mine), 'AAA-changed-by-A');
  await tracker.onTurnEnd('sess-A', 30);

  // A 回退到边 key=10（stateAt 取「key 严格小于 targetSeq 的最后一份」，
  // 所以 targetSeq=30 才会选中 key=10 那份，等价于「回到第 30 轮之前的文件状态」）
  const planA = await tracker.plan('sess-A', 30);
  const rels = planA.actions.map((x) => x.rel);
  ok('A 自己的改动在回退计划里', rels.includes(mine));
  ok('B 会话改过的文件被排除', !rels.includes(theirs));
  const skippedB = planA.skipped.find((s) => s.rel === theirs);
  ok('B 的文件记为 foreign-session 跳过', skippedB?.reason === 'foreign-session');

  // 执行回退后，b.txt 内容必须原样保留
  await tracker.restore('sess-A', 30, 40);
  const bNow = await readFile(join(ws, theirs), 'utf8');
  eq('回退后 b.txt 内容不变', bNow, 'BBB-changed-by-B-session');
  const aNow = await readFile(join(ws, mine), 'utf8');
  eq('回退后 a.txt 已还原为目标状态', aNow, 'AAA');

  await rm(root, { recursive: true, force: true });
}

console.log('5) 单会话时隔离逻辑不误伤（无其他会话 → 正常回退）');
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-solo-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'x.txt'), 'v1');

  const cwds = new Map();
  const tracker = new ArtifactTracker({
    rootDir: () => join(root, 'snap'),
    cwdOf: (id) => cwds.get(id),
    maxFileBytes: 1 << 20,
    baselineContent: true,
    exclude: '',
    keepManifests: 50,
  });
  cwds.set('sess-S', ws);
  await tracker.ensureBaseline('sess-S');
  await tracker.onTurnEnd('sess-S', 10);
  await writeFile(join(ws, 'x.txt'), 'v2-changed');
  await tracker.onTurnEnd('sess-S', 20);

  const planS = await tracker.plan('sess-S', 20);
  ok('单会话：改动被正常识别为 restore', planS.actions.some((a) => a.rel === 'x.txt' && a.action === 'restore'));

  await rm(root, { recursive: true, force: true });
}

console.log('');
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项（通过 ${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
