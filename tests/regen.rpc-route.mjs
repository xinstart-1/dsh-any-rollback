// 回归测试：回退弹窗「无法获取影响清单：transport failure for /dsh-rewind/preview: HTTP 405」
//
// 真实事故（截图 image-22）：点 ↶ 回退，弹窗里写
//   「无法获取影响清单：transport failure for /dsh-rewind/preview: HTTP 405」
//
// 根因不在前端文案，而在宿主侧 RPC 通道**从未注册**：
//   connection.rpc.handle(channel, handler)
//     → get rpc() { const owner = this.ctx; return { handle: (...) => this.register(owner, ...) } }
//     → register(owner, channel, handler) {
//         return owner.effect(() => owner.webServer.register(route), ...)
//       }
// `owner` 是 **connection 服务自己构造时的 ctx**（client-connection 插件的 ctx，
// 它的 inject 只有 ["credentials"]），没有注入 webServer。于是 `owner.webServer`
// 读取抛 `cannot get property "webServer" without inject`；这段又被我们自己的
// try/catch 吞成一条 logger.warn。路由不存在 → POST /dsh-rewind/preview 落到
// 前端静态兜底路由 → HTTP 405。
//
// 关键点：第三方插件**无法**靠声明 inject 修好它 —— owner 由宿主服务捕获，
// 不是调用方的 ctx（本测试用真实 cordis 证明这一点）。
//
// 修复：改用官方给第三方插件的扩展点 connection.fetch.register（路径必须在
// /api 下，由 Connection 的 /api 处理器统一鉴权），dsh-context 等插件即用此。
//
// 本测试两段：
//   1) 用真实 cordis 复现「rpc.handle 注册必失败」，锁定宿主语义；
//   2) 断言 lib/index.js 走 fetch.register、lib/client.js 走 /api Fetch 路由。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

const [hostSrc, clientSrc] = await Promise.all([
  readFile(join(root, 'lib', 'index.js'), 'utf8'),
  readFile(join(root, 'lib', 'client.js'), 'utf8'),
])

console.log('1) 宿主侧：必须用 connection.fetch.register，不能再用 rpc.handle')
{
  check(/connection\.fetch\.register\(\{/.test(hostSrc), '注册 exact Fetch 路由')
  check(/path: REWIND_RPC_PATH/.test(hostSrc), '路由路径用常量 REWIND_RPC_PATH')
  check(/methods: \["POST"\]/.test(hostSrc), '只接受 POST')
  check(/requestBody: "buffered"/.test(hostSrc), '请求体按 buffered 读取')
  check(/var REWIND_RPC_PATH = "\/api\//.test(hostSrc), '路径落在 /api 前缀下（assertFetchRoute 要求）')
  // 旧写法必须消失（注释里提到 rpc.handle 是允许的，只要不是真实调用）
  const rpcHandleCalls = hostSrc.match(/connection\.rpc\.handle\(/g) ?? []
  check(rpcHandleCalls.length === 0, '不再调用 connection.rpc.handle', String(rpcHandleCalls.length))
  // 静默失败的 catch 文案要点出是「路由」而不是含糊的「RPC」
  check(/RPC route registration failed/.test(hostSrc), '注册失败日志措辞指向 route')
}

console.log('2) 客户端侧：走 /api 下的 Fetch 路由，不再走 connection.rpc.call')
{
  check(/var RPC_PATH = "api\/dsh-rewind\/rpc"/.test(clientSrc), '相对路径 api/dsh-rewind/rpc')
  check(!/connection\.rpc\.call\(/.test(clientSrc), '不再调用 connection.rpc.call')
  check(/function hostRpc\(endpoint, payload\)/.test(clientSrc), '统一的 hostRpc 往返函数')
  check(/fetch\(RPC_PATH, \{/.test(clientSrc), '用 fetch 发请求')
  check(/method: "POST"/.test(clientSrc), 'POST 请求')
  check(/application\/json/.test(clientSrc), 'JSON content-type（Connection 只放行 JSON）')
  check(/body: JSON\.stringify\(\{ endpoint, payload \}\)/.test(clientSrc), '请求体带 endpoint + payload')
  // HTTP 非 2xx 必须显式报出来 —— 这条错误文案正是用户看到的那句
  check(/transport failure for \$\{RPC_PATH\}: HTTP \$\{response\.status\}/.test(clientSrc),
    'HTTP 状态非 2xx 时报出可诊断的文案')
}

console.log('3) 前后端协议一致：同一个路径 + 同一个 endpoint 名')
{
  const hostPath = hostSrc.match(/var REWIND_RPC_PATH = "([^"]+)"/)?.[1]
  const clientPath = clientSrc.match(/var RPC_PATH = "([^"]+)"/)?.[1]
  check(hostPath === '/api/dsh-rewind/rpc', '宿主路径 = /api/dsh-rewind/rpc', hostPath)
  check(clientPath === 'api/dsh-rewind/rpc', '客户端相对路径 = api/dsh-rewind/rpc', clientPath)
  // 客户端去掉前导斜杠后必须与宿主路径完全一致
  check('/' + clientPath === hostPath, '客户端相对路径解析后与宿主路径相同', `/${clientPath} vs ${hostPath}`)
  // 宿主按 payload.endpoint 分发；客户端两个调用点都要带上
  check(/endpoint === "preview"/.test(hostSrc), '宿主认 preview 端点')
  check(/endpoint === "candidates"/.test(hostSrc), '宿主认 candidates 端点')
  check(/hostRpc\("preview"/.test(clientSrc), '客户端请求 preview')
  check(/hostRpc\("candidates"/.test(clientSrc), '客户端请求 candidates')
}

console.log('4) 真实 cordis：rpc.handle 在第三方插件上下文必然抛错（锁定宿主语义）')
{
  // 用真实 cordis + 复刻的 HostConnectionService 语义，证明 owner 捕获的是
  // 服务自己的 ctx，第三方注入多少服务都改变不了。
  let Context
  let Service
  try {
    const { pathToFileURL } = await import('node:url')
    const entry = pathToFileURL(join(root, 'scratch', 'asar3', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
    ;({ Context, Service } = await import(entry))
  } catch {
    console.log('  SKIP: 未找到解包的 cordis（scratch/asar3），跳过真实语义复现')
  }
  if (Context !== undefined) {
    class WebServerService extends Service {
      constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
      register(route) {
        this.routes.push(route.path)
        return () => { this.routes = this.routes.filter((p) => p !== route.path) }
      }
    }
    // 复刻 HostConnectionService：super(ctx,'connection')，get rpc() 捕获 this.ctx
    class ConnectionService extends Service {
      constructor(ctx) { super(ctx, 'connection'); this.channels = [] }
      get rpc() {
        const owner = this.ctx
        return { handle: (channel, handler) => this.register(owner, channel, handler) }
      }
      register(owner, channel, handler) {
        return owner.effect(() => owner.webServer.register({ kind: 'prefix', path: channel, handler }), `rpc ${channel}`)
      }
    }

    const app = new Context()
    app.plugin({ name: 'webserver-host', apply(ctx) { new WebServerService(ctx) } })
    app.plugin({ name: 'client-connection', apply(ctx) { new ConnectionService(ctx) } })

    let thrown
    app.plugin({
      name: 'rewind-probe',
      inject: ['connection', 'webServer'],
      apply(ctx) {
        ctx.inject(['connection', 'webServer'], (scope) => {
          try {
            scope.connection.rpc.handle('/dsh-rewind', () => {})
          } catch (error) {
            thrown = error
          }
        })
      },
    })
    await new Promise((r) => setTimeout(r, 250))

    check(thrown !== undefined, 'rpc.handle 抛出（不是静默成功）')
    check(/cannot get property "webServer" without inject/.test(thrown?.message ?? ''),
      '抛的是 webServer 未注入', thrown?.message)
    // 即使插件自己声明了 webServer 依赖也救不了 —— owner 是宿主服务的 ctx
    check(app.get('webServer').routes.length === 0,
      '路由一条也没注册上（这就是 405 的来历）', JSON.stringify(app.get('webServer').routes))
  }
}

console.log('5) 真实 cordis：fetch.register 在同样的插件上下文里能注册成功（正向证明）')
{
  let Context
  let Service
  try {
    const { pathToFileURL } = await import('node:url')
    const entry = pathToFileURL(join(root, 'scratch', 'asar3', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
    ;({ Context, Service } = await import(entry))
  } catch {
    console.log('  SKIP: 未找到解包的 cordis（scratch/asar3），跳过')
  }
  if (Context !== undefined) {
    // 复刻真实的 fetch 注册表：registerFetchRoute 只往自己的 Map 里塞，
    // 不碰 owner.webServer —— 所以第三方插件能用。
    class ConnectionService extends Service {
      constructor(ctx) {
        super(ctx, 'connection')
        this.fetchRoutes = new Map()
      }
      get fetch() {
        const owner = this.ctx
        return { register: (route) => this.registerFetchRoute(owner, route) }
      }
      registerFetchRoute(owner, route) {
        return owner.effect(() => {
          this.fetchRoutes.set(route.path, route)
          return () => this.fetchRoutes.delete(route.path)
        }, `fetch ${route.path}`)
      }
    }

    const app = new Context()
    app.plugin({ name: 'client-connection', apply(ctx) { new ConnectionService(ctx) } })

    let threw
    app.plugin({
      name: 'rewind-probe-fetch',
      inject: ['connection'],
      apply(ctx) {
        ctx.inject(['connection'], (scope) => {
          try {
            scope.connection.fetch.register({
              path: '/api/dsh-rewind/rpc',
              methods: ['POST'],
              requestBody: 'buffered',
              fetch: async () => new Response('{"ok":true}'),
            })
          } catch (error) {
            threw = error
          }
        })
      },
    })
    await new Promise((r) => setTimeout(r, 250))

    check(threw === undefined, 'fetch.register 不抛错', threw?.message)
    check(app.get('connection').fetchRoutes.has('/api/dsh-rewind/rpc'),
      '路由真的注册进了表里（对比第 4 段一条都没有）',
      JSON.stringify([...app.get('connection').fetchRoutes.keys()]))
  }
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
