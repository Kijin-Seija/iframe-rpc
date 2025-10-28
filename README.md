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
 - 支持嵌套对象与嵌套返回：值深度复刻（剔除函数），函数以“点路径”暴露（如 `nested.test`）；同时支持“函数返回对象（包含函数）”“函数返回函数”等场景，客户端会为返回值创建临时代理并继续调用
 - 初始化错误提示与超时：服务端初始广播失败会发送 `INIT_ERROR`；客户端支持握手超时（可配置），在失败或超时时明确提示

## 安装

发布到 npm 后：

- `npm install iframe-rpc-client iframe-rpc-server`

本仓库本地开发示例直接从源码引入（见 `src/main.ts` 与 `src/iframe-main.ts`），用于快速调试。

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

// 函数返回对象（对象内含函数）
const nestedObj = await myApi.testNested(1)
console.log(nestedObj.a) // 1001
console.log(await nestedObj.test(1)) // 1001
```

> 注意：客户端初始化是异步的，需要 `await`。所有函数均以 `Promise` 返回。

可选握手超时：

```ts
// 默认超时 5000ms，可自定义
const myApi = await createIframeRpcClient('testApi', { timeout: 8000 })
```

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
```

## 本地开发与调试

- 启动开发服务器：`npm run dev`
- 外层页面预览：`http://localhost:5173/`
- iframe 页面预览：`http://localhost:5173/iframe.html`

开发示例：
- 外层页面（`src/main.ts`）会创建一个 `iframe` 指向 `iframe.html`，并在握手完成后演示对 `api` 的读取与函数调用
- iframe 页面（`iframe.html`）加载 `src/iframe-main.ts`，注册名为 `testApi` 的服务

## 构建与发布

- 构建两个包：`npm run build`
- 产物输出：
  - `packages/iframe-rpc-server/dist/index.js`（ESM），`index.umd.cjs`（UMD）
  - `packages/iframe-rpc-client/dist/index.js`（ESM），`index.umd.cjs`（UMD）
- 发布（示例）：
  - `npm publish -w iframe-rpc-server`
  - `npm publish -w iframe-rpc-client`

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
 - `INIT_ERROR`：服务端初始 `READY` 广播失败时发送，包含错误消息字符串；客户端收到后直接拒绝初始化 Promise

## 安全与跨域

- 当前实现使用 `postMessage(..., '*')`，未限制 `origin`，适合同域或受控环境
- 生产环境建议：
  - 在服务端与客户端传入允许的 `origin`，对 `event.origin` 做校验
  - 根据实际需要屏蔽或过滤敏感 API

## 已知限制与规划

- 值快照不会自动同步：iframe 内更新 `api.a` 不会实时推送到客户端。可扩展 `UPDATE` 消息实现动态更新
- 调用队列：当前不缓存握手前的调用。可选增强是在客户端内部添加队列，在 `READY` 后统一发送
- 多实例支持：如需同时注册多个同名服务实例，可基于 `event.source` 或显式 iframe 引用区分
 - 值快照剔除函数：对象或数组中的函数不会出现在 `values` 快照中；当函数位于返回值中时通过“句柄包装”支持调用。目前数组元素为函数的场景未做路径收集（可后续增强）。

## 目录结构（简要）

```
/               # 根项目（工作区）
├─ packages/
│  ├─ iframe-rpc-server/  # 服务端包
│  └─ iframe-rpc-client/  # 客户端包
├─ src/                   # 本地调试源码
│  ├─ main.ts             # 外层页面入口
│  ├─ iframe-main.ts      # iframe 页面入口（服务端）
│  └─ types.ts            # 测试类型示例
├─ tests/                 # 单元测试
│  └─ rpc.test.ts
├─ index.html             # 外层页面
├─ iframe.html            # iframe 页面
```

---

如需：类型声明打包、`origin` 安全校验、调用队列或动态快照更新等增强功能，可在后续版本中加入。我可以根据你的需求继续完善。
