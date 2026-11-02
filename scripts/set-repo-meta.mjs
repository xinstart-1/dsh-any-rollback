// one-shot: set the GitHub repo description / topics / release notes with
// explicit UTF-8 bodies (PowerShell's default body encoding mangles CJK).
import { execFileSync } from 'node:child_process'

const repo = 'xinstart-1/dsh-rollback'

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  return out.split('\n').find((l) => l.startsWith('password=')).slice(9).trim()
}

const auth = { Authorization: `token ${token()}`, 'User-Agent': 'dsh', Accept: 'application/vnd.github+json' }

async function call(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`${method} ${path} -> ${res.status}`)
    console.error(text.slice(0, 500))
    process.exit(1)
  }
  return text ? JSON.parse(text) : undefined
}

const description =
  'dsh-rewind-plugin 0.19.1 的产物追踪补丁版：命令产出的文件（渲染 / ffmpeg / 构建脚本）也能随对话回退一起还原或隔离，适配 DSH 0.2.1 线'
const topics = ['deepseek-harness', 'dsh', 'dsh-plugin', 'cordis', 'rewind', 'rollback', 'artifact', 'snapshot']

const patched = await call('PATCH', `/repos/${repo}`, { description, has_wiki: false, has_projects: false })
console.log('简介:', patched.description)
console.log('长度:', patched.description.length)

const topicRes = await call('PUT', `/repos/${repo}/topics`, { names: topics })
console.log('topics:', (topicRes.names ?? []).join(', '))

const notes = `\`dsh-rollback\` 是上游 \`dsh-rewind-plugin@0.19.1\` 的非官方重打包，加了「命令产物追踪」补丁，
供 DSH harness **0.2.1 线**使用（上游 0.20.0-alpha.1 要求 DSH \`>=0.2.2-alpha.2\`，在 0.2.1 线上加载即被拒）。

## 补了什么

上游只备份 \`write\` / \`edit\` 碰过的文件。\`node render.mjs\`、\`ffmpeg\`、构建或数据脚本产出的文件永远进不了
追踪清单，回退时完全不动：目标时刻还不存在的文件会留在磁盘上，字节变过的文件保留新内容。

本补丁在每个回合边界写一份工作区清单，只对**发生变化**的条目缓存内容；回退时还原缓存的字节，
而目标时刻还不存在的产物会被**移入隔离区**（不是删除），去向记入 \`index.json\`，可人工取回。

## 安装

\`\`\`json
"dependencies": {
  "dsh-rollback": "https://github.com/xinstart-1/dsh-rollback/releases/download/v0.19.1-rb.1/dsh-rollback-0.19.1.tgz"
}
\`\`\`

装完**重启 DSH**。同时确认 \`dsh-rollback\` 在该 profile 的 \`dsh.profile.bundles\` 数组里；
如果那里还留着 \`dsh-rewind-plugin\`，把旧行一起删掉，否则两个回退界面会各渲染一个 ↶ 按钮。

## 附件

| 文件 | SHA-256 |
| --- | --- |
| \`dsh-rollback-0.19.1.tgz\` | \`0e0bd8f9ad4a79aeb382b15fa29e8dac27b95552b6d17249dea5c931e74cb46f\` |

可用 \`node scripts/verify.mjs <包目录>\` 校验。

## 注意

- 内部标识刻意保留上游名字，旧数据继续可读：会话标记 \`dsh-rewind\`、快照目录 \`rewind-snapshots\`、
  RPC 频道 \`/dsh-rewind\`。
- 改名会丢掉旧的设置文档（DSH 按 entry id 存配置）：到插件页把备份开关和清理策略重设一次即可，
  已存的快照不受影响。
- 补丁打在构建产物层。从 npm registry 装上游包拿回的是没有补丁的版本，请用本仓库的 tarball 重装。
- 上游把这个追踪边界当作有意的设计取舍（\`docs/compat/tracking-boundary.md\`，Limitation 1），
  因此本补丁属于本地绕行方案，不预期会被上游采纳。
`

const releases = await call('GET', `/repos/${repo}/releases`)
const target = releases.find((r) => r.tag_name === 'v0.19.1-rb.1')
const updated = await call('PATCH', `/repos/${repo}/releases/${target.id}`, {
  name: 'v0.19.1-rb.1 · 产物追踪补丁版',
  body: notes,
})
console.log('Release 名称:', updated.name)
console.log('Release 正文长度:', updated.body.length)