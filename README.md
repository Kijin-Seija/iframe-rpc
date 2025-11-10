# iframe-rpc

基于 `iframe` 的 `postMessage` 双端 RPC 库，让外层页面可以像调用本地函数一样调用 `iframe` 内的函数，并拿到异步结果。项目拆分为两个包：

- `iframe-rpc-server`：在 `iframe` 内注册 API 并响应调用
- `iframe-rpc-client`：在外层页面基于名称创建代理对象进行调用

当前仓库同时提供了本地调试页面与单元测试，便于开发与验证。

## 特性

- 双包架构：服务端与客户端独立封装，互相解耦
- 异步初始化：`createIframeRpcClient(name)` 返回 `Promise`，握手完成后解析代理
- 函数 Promise 化：所有函数调用返回 `Promise<结果>`
- 简单协议：`READY / GET / CALL / RESULT / ERROR`
- 支持并发：多个调用互不干扰，按 `id` 关联结果
 - Getter 值支持：服务端在构建“值快照”时会读取对象上的 getter（包含原型链与非枚举的 getter），并以“当前值”传递到客户端；不保留 getter 的动态语义（不会自动更新）
 - 支持嵌套对象与嵌套返回：值深度复刻（剔除函数），函数以“点路径”暴露（如 `nested.test`）；同时支持“函数返回对象（包含函数）”“函数返回函数”等场景，客户端会为返回值创建临时代理并继续调用
 - 初始化错误提示与超时：服务端初始广播失败会发送 `INIT_ERROR`；客户端支持握手超时（可配置），在失败或超时时明确提示
 - 返回值句柄释放：函数返回对象/函数时会创建“临时句柄”（handle）；支持显式释放与自动释放，避免句柄长期常驻

- 异步返回支持：函数返回 `Promise` 时服务端会自动 `await` 并按当前逻辑处理嵌套结构（对象/函数均可），客户端类型与行为保持一致

- 页面生命周期策略：客户端支持 `releaseOnPageHide: 'nonPersisted' | 'all' | 'off'`（默认 `nonPersisted`）；`beforeunload` 始终批量释放
- 服务端闲置 TTL 清理：支持配置 `handleTtlMs` 与 `sweepIntervalMs`，对长时间未使用的句柄进行定期回收

## 安装

发布到 npm 后：

- `npm install iframe-rpc-client iframe-rpc-server`

本仓库本地开发示例直接从源码引入（见 `demo/main.ts` 与 `demo/iframe-main.ts`），用于快速调试。

## 仓库结构与共享模块

- `packages/iframe-rpc-client/`：客户端实现与打包配置
- `packages/iframe-rpc-server/`：服务端实现与打包配置
- `shared/`：双端内部共享的类型与工具（非对外 API）
  - `shared/types.ts`：`RpcMessage`、`StructuredCloneValue`、`Promisified<T>`、客户端/服务端配置项等公共类型定义
  - `shared/utils.ts`：基础工具函数，供双端复用（如 `isObject`、`brandTag`、`isTypedArray`、`genId`、`isStructuredClonePassThrough`、`getDeep`、`serializeError`、`listReadableKeys`、`listFunctionKeysForCollect`、`collectFunctionPaths`、`cloneValuesOnly`、`buildCanonicalIndex`）
- `tests/`：单元与集成测试
  - `utils.test.ts` 覆盖共享工具的全部导出方法
  - `rpc.test.ts` 覆盖握手、值快照、函数路径、句柄释放、并发、生命周期与跨域校验
- `demo/`：本地调试用示例页面与脚本

说明：外部使用请通过 npm 包导出的 API（`iframe-rpc-client` / `iframe-rpc-server`）。`shared/` 目录为 monorepo 内部实现细节，不作为对外稳定接口。

### ID 生成策略（内部）

双端统一使用 `shared/utils.ts` 中的 `genId()` 生成唯一 ID（时间戳 + 随机段），确保并发调用按 `id` 正确关联结果。若需更强唯一性（跨多进程/更低碰撞率），可在内部替换为 `crypto.getRandomValues` 或扩展随机段长度。

## 快速开始

### 在 iframe 内注册服务（server）

```ts
import { createIframeRpcServer } from 'iframe-rpc-server'

const api = {
  a: 1,
  test: (param: number) => {
    console.log('hi, im test api')
    return param + 1
  },
  nested: {
    a: 2,
    test: (param: number) => {
      console.log('hi, im nested test api')
      return param + 10
    },
  },
}

createIframeRpcServer(api, { name: 'testApi' })
```

### 在外层页面创建客户端（client）

```ts
import { createIframeRpcClient } from 'iframe-rpc-client'

const myApi = await createIframeRpcClient('testApi')
console.log(myApi.a)           // 1
console.log(await myApi.test(1)) // 2
console.log(myApi.nested.a)    // 2
console.log(await myApi.nested.test(1)) // 11

// 函数返回 Promise 的示例
console.log(await myApi.testPromise(1)) // 2
// 函数返回 Promise<对象>：解构后对象内的函数可继续调用
const asyncObj = await myApi.mkObjAsync(5)
console.log(asyncObj.a)                    // 105
console.log(await asyncObj.test(2))        // 7
// 函数返回 Promise<函数>
const add2Async = await myApi.mkAdderAsync(2)
console.log(await add2Async(3))            // 5

// 函数返回对象（对象内含函数）
const nestedObj = await myApi.testNested(1)
console.log(nestedObj.a) // 1001
console.log(await nestedObj.test(1)) // 1001

// 释放返回值句柄（对象或函数）
;(nestedObj as any).__release() // 显式释放，后续调用会直接报错
// 例如：await nestedObj.test(1) // -> Promise.reject(Error('Handle ... released'))
```

> 注意：客户端初始化是异步的，需要 `await`。所有函数均以 `Promise` 返回。

可选握手超时：

```ts
// 默认超时 5000ms，可自定义
const myApi = await createIframeRpcClient('testApi', { timeout: 8000 })
```

### 循环引用支持

服务端与返回值中的对象如果包含循环引用（如 `obj.self === obj` 或子对象引用父对象），库会：
- 在“值快照”中保留循环结构（避免无限递归，性能安全）
- 收集函数路径时避免沿循环无限展开，仅记录首次遇到的最短路径

示例：

```ts
// server（iframe 内）
const cycle: any = { a: 1, nested: { val: 2 } }
cycle.self = cycle
cycle.nested.parent = cycle
cycle.nested.fn = (n: number) => n + cycle.a
createIframeRpcServer({ cycle }, { name: 'cycleDemo' })

// client（外层页面）
const api = await createIframeRpcClient('cycleDemo')
console.log(api.cycle.a)                 // 1
console.log(api.cycle.self.a)            // 1（循环引用）
console.log(api.cycle.nested.parent.a)   // 1（子对象回指父对象）
console.log(await api.cycle.nested.fn(2)) // 3（函数调用）
console.log(await api.cycle.self.nested.fn(2)) // 3（循环别名路径调用，自动映射到最短路径）

// 注意：函数路径采用首次遇到的最短路径，例如 'cycle.nested.fn'。
// 客户端支持循环别名调用：通过别名（如 'cycle.self.nested.fn'）将自动映射到最短路径并成功调用。
```

### 页面生命周期策略（client）

客户端在页面隐藏或离开时可配置释放策略，用于在 BFCache 等场景下保持或释放返回值句柄：

```ts
import { createIframeRpcClient } from 'iframe-rpc-client'

// 默认策略（nonPersisted）：仅在非 BFCache 的 pagehide 上释放
const apiDefault = await createIframeRpcClient('testApi', { releaseOnPageHide: 'nonPersisted' })

// 始终在 pagehide 释放（包括 BFCache）：
const apiAll = await createIframeRpcClient('testApi', { releaseOnPageHide: 'all' })

// 不在 pagehide 释放（适合希望 BFCache 恢复后继续使用已有代理）：
const apiOff = await createIframeRpcClient('testApi', { releaseOnPageHide: 'off' })

// 说明：
// - BFCache 场景下，pagehide 事件对象的 ev.persisted === true
// - 无论策略如何，beforeunload 始终作为兜底批量释放句柄
```

### 服务端闲置 TTL 清理（server）

为防止返回值句柄长期占用内存，服务端支持基于“闲置 TTL”的定期清理：

```ts
import { createIframeRpcServer } from 'iframe-rpc-server'

createIframeRpcServer(api, {
  name: 'testApi',
  handleTtlMs: 10 * 60 * 1000,   // 句柄闲置超时（默认 10 分钟）
  sweepIntervalMs: 60 * 1000     // 清扫周期（默认 60 秒）
})

// 行为说明：
// - 返回对象/函数时会创建句柄，并记录 lastUsed 时间戳
// - 每次基于句柄的调用都会刷新 lastUsed
// - 清扫器会定期删除超过 TTL 的句柄；此后再次调用该句柄会返回 ERROR: Handle <id> not found
```

## Getter 支持与错误处理

行为概述：

- 服务端在 `READY` 构建快照时会读取对象上的 getter（包含自身可枚举属性、自身非枚举的访问器属性，以及原型链上的访问器属性，排除 `constructor`），并将“当前值”传递到客户端的 `values`。不保留 getter 的动态语义（不会自动刷新）。
- 若读取某个 getter 抛出错误，服务端会跳过该属性，不将其暴露到客户端。此时客户端访问该键返回 `undefined`，且不会生成函数代理。

示例：

```ts
// server
import { createIframeRpcServer } from 'iframe-rpc-server'

const api: any = {
  get title() { return 'Hello' },
  get unstable() { throw new Error('not-ready') }
}
Object.defineProperty(api, 'hidden', {
  get() { return 42 },
  enumerable: false
})

class Doc {
  private _count = 7
  get count() { return this._count }
}
api.doc = new Doc()

createIframeRpcServer(api, { name: 'docApi' })

// client
import { createIframeRpcClient } from 'iframe-rpc-client'
const client = await createIframeRpcClient('docApi')
console.log(client.title)     // 'Hello'
console.log(client.count)     // 7（原型链 getter）
console.log(client.hidden)    // 42（非枚举 getter）
console.log(client.unstable)  // undefined（读取时抛错，已跳过）
```

最佳实践：

- 若需要“最新值”，提供无参函数（如 `getTitle()`）并在客户端以 `await` 调用，或实现增量 `UPDATE` 推送协议。
- getter 返回值需可结构化克隆；函数不会作为值克隆，而是通过函数路径暴露。
- 避免在初始化阶段 getter 执行重计算或副作用；将耗时逻辑放到显式函数里。

## TypeScript 支持

你可以为服务端 API 编写接口类型，客户端会自动将函数的返回值映射为 `Promise<...>`。

```ts
// 定义服务端 API 类型
export interface TestApi {
  a: number
  test: (n: number) => number
  nested: {
    a: number
    test: (n: number) => number
  }
  // 函数返回对象（其中包含函数）
  testNested: (n: number) => {
    a: number
    test: (n: number) => number
  }
}

// 客户端传入泛型后，函数返回值将推断为 Promise<number>
const myApi = await createIframeRpcClient<TestApi>('testApi')
// myApi.a: number
// myApi.test: (n: number) => Promise<number>
// myApi.nested.a: number
// myApi.nested.test: (n: number) => Promise<number>
```

同时，客户端包导出了一个类型工具：

```ts
import type { Promisified } from 'iframe-rpc-client'

type MyApi = Promisified<TestApi> // 深度 Promise 化，嵌套函数也映射为 Promise 返回
// 说明：Promisified<T> 递归处理函数返回值：
// - 函数返回值 -> Promise<Promisified<返回值>>
// - 对象属性中的函数返回 Promise<...>
// - 如果某函数返回另一个函数，则外层返回 Promise<内层函数代理>，内层函数调用仍返回 Promise<结果>
// - 如果函数返回 Promise<对象/函数>，服务端会解构 Promise 后按上述规则继续处理
```

## 本地开发与调试

- 启动开发服务器：`npm run dev`
- 外层页面预览：`http://localhost:5173/`
- iframe 页面预览：`http://localhost:5173/iframe.html`

开发示例：
- 外层页面（`demo/main.ts`）会创建一个 `iframe` 指向 `iframe.html`，并在握手完成后演示对 `api` 的读取与函数调用
- iframe 页面（`iframe.html`）加载 `demo/iframe-main.ts`，注册名为 `testApi` 的服务

## 构建与发布

- 构建两个包：`npm run build`
- 一键发布：`npm run publish:all`（先编译，再依次发布两个包）
- 产物输出：
  - `packages/iframe-rpc-server/dist/index.js`（ESM），`index.umd.cjs`（UMD）
  - `packages/iframe-rpc-client/dist/index.js`（ESM），`index.umd.cjs`（UMD）
- 发布（示例）：
  - `npm publish -w iframe-rpc-server`
  - `npm publish -w iframe-rpc-client`

提示：执行发布前需先完成 `npm login` 并拥有对应包的发布权限；如需仅验证构建可先运行 `npm run build`。

## 单元测试

- 运行测试：`npm run test`
- 覆盖内容：
  - 值复刻与函数 Promise 化
  - 错误传播（服务端抛错 -> 客户端 Promise reject）
  - 并发调用（多个请求并行、结果正确回传）
  - 嵌套对象支持（读取嵌套值、调用嵌套函数）
  - 初始化失败提示（服务端 READY 失败 -> 客户端收到 INIT_ERROR）
  - 握手超时（消息无法送达时客户端自动拒绝 Promise）

测试实现通过一个 `FakeWindow` 模拟 `postMessage` 的父/子窗口通信，使用 `node` 环境，无需 `jsdom`。

## 协议说明

- `READY`：服务端启动后向父窗口广播，包含值快照与函数名称列表
- `GET`：客户端可选的快照请求（当前实现主要依赖服务端主动 `READY`）
- `CALL`：客户端请求调用函数，包含 `id`、方法名与参数
- `RESULT`/`ERROR`：服务端返回结果或错误，与请求 `id` 对应
  - 当结果中包含函数（或结果本身是函数）时，服务端返回一个“句柄包装”对象：`{ __rpc__: 'handle', id, kind: 'object'|'function', values, functions }`。客户端基于此创建临时代理继续调用；调用时会在消息中附带 `handle: id` 指向该返回值上下文。
 - 当函数返回值为 `Promise<...>` 时，服务端在发送 `RESULT` 前会先异步解构（await）该 Promise，并对解构后的结果按上述规则进行处理。
 - `INIT_ERROR`：服务端初始 `READY` 广播失败时发送，包含错误消息字符串；客户端收到后直接拒绝初始化 Promise
  - `RELEASE_HANDLE`：客户端在不再需要某返回值代理时发送，服务端删除对应 `handle`。删除后再次调用会返回错误；客户端同时在本地立即拒绝对已释放句柄的调用。

## 句柄生命周期与释放

- 何为“句柄”：当某次调用返回对象（且对象中含函数）或直接返回函数时，服务端不会把函数本体透传给客户端，而是返回一个“句柄包装”并在服务端保存该返回值。客户端据此构建临时代理继续调用。
- 生命周期：默认“调用后常驻”。为避免泄漏，提供两种释放方式：
  - 显式释放：在对象/函数代理上调用 `__release()`，会发送 `RELEASE_HANDLE` 消息并在客户端标记为已释放。
  - 自动释放：如果运行环境支持 `FinalizationRegistry`，当代理对象被 GC 时会自动发送释放请求。
  - 弱引用轮询释放（降级）：在不支持 `FinalizationRegistry` 但支持 `WeakRef` 的环境下，客户端将以低频率轮询弱引用；当代理对象被 GC，自动发送 `RELEASE_HANDLE`。
  - 页面生命周期兜底：在 `beforeunload/pagehide` 事件触发时，客户端会批量释放所有活跃句柄，避免页面退出造成未释放。
- 释放后的行为：
  - 客户端对已释放句柄的再次调用会立即返回 `Promise.reject(Error('Handle ... released'))`，无需等待服务端响应。
  - 如果仍然向服务端发送了调用消息（例如跨环境未及时同步），服务端也会返回 `ERROR: Handle <id> not found`。

### 页面生命周期与 BFCache

- `pagehide`：页面被隐藏时触发，可能是正常导航/关闭，也可能是进入 BFCache。事件对象上 `ev.persisted === true` 表示进入 BFCache。
- 客户端策略 `releaseOnPageHide`：
  - `'nonPersisted'`（默认）：仅在 `persisted:false` 时释放句柄，进入 BFCache 时不释放，页面恢复后代理仍可用。
  - `'all'`：无论是否 BFCache，`pagehide` 都释放句柄；恢复后需重新获取代理。
  - `'off'`：不在 `pagehide` 释放（但 `beforeunload` 仍释放）。
- 兜底 `beforeunload`：在页面真正卸载前触发，不会在 BFCache 情况出现；客户端始终在该事件上批量释放句柄。

示例：

```ts
const obj = await myApi.testNested(5)
console.log(await obj.test(1)) // 6
;(obj as any).__release()      // 显式释放
await obj.test(1)              // -> rejects with Error('Handle ... released')

const fn = await myApi.mkAdder(2)
console.log(await fn(3))       // 5
;(fn as any).__release()       // 释放函数句柄
await fn(3)                    // -> rejects
```

## 最佳实践

- 释放后重新获取句柄（重新调用原始 API 获取新句柄）

```ts
// 再次调用原始 API，生成新的句柄
const nested1 = await myApi.testNested(1)
;(nested1 as any).__release() // 释放旧句柄

// 重新获取一个全新的句柄
const nested2 = await myApi.testNested(1)
console.log(await nested2.test(2)) // 正常工作
```

- 控制页面生命周期释放（client）

```ts
// 默认 releaseOnPageHide 是 'nonPersisted'；需要持久保留可改为 'off'
const myApi = await createIframeRpcClient('testApi', {
  releaseOnPageHide: 'off', // 不在 pagehide 释放（BFCache 与非 BFCache 都不释放）
})
```

说明：
- BFCache 场景下，`pagehide` 事件对象的 `ev.persisted === true`
- 无论策略如何，`beforeunload` 始终作为兜底批量释放句柄

- 延长服务端句柄寿命（server）

```ts
import { createIframeRpcServer } from 'iframe-rpc-server'

createIframeRpcServer(api, {
  name: 'testApi',
  handleTtlMs: 10 * 60 * 1000, // 句柄闲置超时（默认 10 分钟）
  sweepIntervalMs: 60 * 1000   // 清扫周期（默认 60 秒）
})
```

说明：
- 返回对象/函数时会创建句柄，并记录 lastUsed 时间戳
- 每次基于句柄的调用都会刷新 lastUsed
- 清扫器会定期删除超过 TTL 的句柄；此后再次调用该句柄会返回 `ERROR: Handle <id> not found`

- 稳定资源的“可重取”设计（进阶）

```ts
// 示例：按用户 id 管理会话，支持重复获取同一会话对象（新句柄指向同一资源）
const sessions = new Map<string, ReturnType<typeof createSession>>()

export const api = {
  getSession(id: string) {
    let s = sessions.get(id)
    if (!s) {
      s = createSession(id) // 你的业务创建逻辑
      sessions.set(id, s)
    }
    return s // 返回对象/函数，客户端得到一个新句柄，但状态来自同一 session
  }
}
```

注意：这属于你的业务层设计，需自行管理这些资源的生命周期，以避免内存占用过大。

## 安全与跨域

- 当前实现使用 `postMessage(..., '*')`，未限制 `origin`，适合同域或受控环境
- 生产环境建议：
  - 在服务端与客户端传入允许的 `origin`，对 `event.origin` 做校验
  - 根据实际需要屏蔽或过滤敏感 API

### 配置允许的 origin 与发送目标 origin

服务端（iframe 内）：

```ts
import { createIframeRpcServer } from 'iframe-rpc-server'

createIframeRpcServer(api, {
  name: 'docApi',
  // 仅允许来自这些来源的消息被处理（其他来源将被忽略）
  allowedOrigins: ['https://your-parent.com'],
  // 启动广播 READY/INIT_ERROR 时的发送目标（默认 '*'）。已知父页面来源时建议设置为精确 origin。
  targetOrigin: 'https://your-parent.com',
})
```

客户端（外层页面）：

```ts
import { createIframeRpcClient } from 'iframe-rpc-client'

// 如果已知 iframe 的来源，可同时设置接收与发送的校验/目标
const iframeOrigin = new URL(document.getElementById('demo-iframe').src).origin

const client = await createIframeRpcClient('docApi', {
  // 仅接受来自这些来源的服务端消息（READY/RESULT/ERROR）
  allowedOrigins: [iframeOrigin],
  // 发送 CALL/RELEASE_HANDLE 时的目标（默认在握手后自动使用服务端的 event.origin）
  targetOrigin: iframeOrigin,
})
```

实现细节：

- 客户端与服务端在处理 `message` 事件时会检查 `event.origin` 是否在 `allowedOrigins` 白名单内；不在白名单的消息将被忽略。
- 服务端在响应消息时使用 `event.origin` 作为 `postMessage` 的 `targetOrigin`；初始向父窗口广播 `READY/INIT_ERROR` 时使用 `options.targetOrigin`（默认 `'*'`）。
- 客户端在握手完成后记录服务端的来源，并在后续调用时优先使用该来源作为 `targetOrigin`；若显式设置了 `options.targetOrigin`，则使用该值。

## 已知限制与规划

- 值快照不会自动同步：iframe 内更新 `api.a` 不会实时推送到客户端。可扩展 `UPDATE` 消息实现动态更新
 - Getter 行为说明：客户端拿到的是初始化时的 getter 当前值，不会自动刷新。如需取最新值，请在服务端提供无参函数并在客户端异步调用，或扩展 `UPDATE` 推送。
 - Getter 抛错处理：初始化阶段读取 getter 抛出错误时，该属性会被跳过，不会暴露到客户端；客户端访问该键为 `undefined`。
- 调用队列：当前不缓存握手前的调用。可选增强是在客户端内部添加队列，在 `READY` 后统一发送
- 多实例支持：如需同时注册多个同名服务实例，可基于 `event.source` 或显式 iframe 引用区分
 - 值快照剔除函数：对象或数组中的函数不会出现在 `values` 快照中；当函数位于返回值中时通过“句柄包装”支持调用。已支持数组元素为函数的路径收集与代理（例如 `arr.0`、`arr.1.inner`）。原型链上的方法（class 原型方法）也会被收集为函数路径并可调用，但不会作为值进入快照。
 - Map/Set 支持说明：仅支持“基本类型值”（如 `string`、`number`、`boolean`、`null`、`undefined`）作为条目值；条目中的函数会被剔除且不支持调用。Map/Set 条目中的函数不会被路径收集，如需调用函数请将函数作为对象属性或返回值中的函数暴露，由句柄代理继续调用。
 - 循环引用：值快照保留循环结构；函数路径收集采用首次遇到的最短路径。客户端对循环别名提供调用支持：别名路径自动映射到最短路径，不会出现 `undefined`。

## 目录结构（简要）

```
/               # 根项目（工作区）
├─ packages/
│  ├─ iframe-rpc-server/  # 服务端包
│  └─ iframe-rpc-client/  # 客户端包
├─ demo/                  # 本地调试源码（原 src）
│  ├─ main.ts             # 外层页面入口
│  ├─ iframe-main.ts      # iframe 页面入口（服务端）
│  └─ types.ts            # 测试类型示例
├─ tests/                 # 单元测试
│  └─ rpc.test.ts
├─ index.html             # 外层页面
├─ iframe.html            # iframe 页面
```

### 结构可视化（默认物化）

 默认开启“物化模式”：客户端会将初始快照构建为真实、可枚举的对象树，并把函数作为实际属性挂载。函数来源包括：自身可枚举属性中的函数、getter 返回的函数、以及原型链上的方法（例如 class 的原型方法）。若需获得最高性能或更严格的结构隐藏，可设置 `hideStructure: true` 关闭物化，回退为懒代理。

```ts
import { createIframeRpcClient } from 'iframe-rpc-client'

// 默认物化（无需传参）：
const api = await createIframeRpcClient('testApi')

// 禁用物化（最高性能/更严格结构隐藏）：
const apiHidden = await createIframeRpcClient('testApi', { hideStructure: true })

// 在物化模式下可以自然查看结构：
console.log(Object.keys(api))           // 顶层键列表
console.log(typeof api.nested.test)     // 'function'（真实属性）
console.log(await api.nested.test(1))   // 11（正常调用）
```

行为说明：
- 物化基于服务端 `READY` 的初始“值快照”，保留循环引用；例如 `cycle.self === cycle` 会在客户端保持为同一对象，别名路径下能看到并调用相同的函数属性。
- 函数不会作为值透传，但会在其“最短路径”的父对象上挂载为真实函数属性；由于循环别名指向同一对象实例，别名路径下同样可见并可调用。
- 这是静态结构，随后 iframe 内部值变化不会自动同步；若需要最新值，请提供无参函数（如 `getXxx()`）或扩展 `UPDATE` 协议。
- 返回值句柄行为：默认物化返回的“对象句柄”为真实、可枚举的对象树；返回的“函数句柄”仍为轻量代理（具备 `__release()`），以便生命周期管理。开启 `hideStructure: true` 后，返回的对象句柄也回退为懒代理（不可枚举、通过 Proxy 延迟访问函数）。

示例（返回值物化）：

```ts
const user = await api.getUser(1)
console.log(Object.keys(user)) // ['id', 'name', 'reload', 'posts']
await user.reload()
await user.__release() // 释放后再调用将报错
```

示例（类原型方法调用与 this 绑定）：

```ts
// server
class A {
  n = 3
  foo() { return this.n + 1 } // 原型方法
  bar = () => this.n + 2      // 字段方法
}
createIframeRpcServer({ a: new A() }, { name: 'class-demo' })

// client（默认物化）
const api = await createIframeRpcClient('class-demo')
console.log(await api.a.foo()) // 4（原型方法可见且 this 绑定到实例）
console.log(await api.a.bar()) // 5（字段方法同样可调用）
```
