// Shared types for iframe-rpc client and server

export type RpcMessage =
  | {
      rpc: 'iframe-rpc'
      name: string
      type: 'READY'
      payload: { values: Record<string, any>; functions: string[] }
    }
  | { rpc: 'iframe-rpc'; name: string; type: 'RESULT'; id: string; result: any }
  | { rpc: 'iframe-rpc'; name: string; type: 'ERROR'; id: string; error: string }
  | { rpc: 'iframe-rpc'; name: string; type: 'GET' }
  | { rpc: 'iframe-rpc'; name: string; type: 'CALL'; id: string; method: string; args: any[]; handle?: string }
  | { rpc: 'iframe-rpc'; name: string; type: 'INIT_ERROR'; error: string }
  | { rpc: 'iframe-rpc'; name: string; type: 'RELEASE_HANDLE'; handle: string }

// 与运行时 isStructuredClonePassThrough 对齐的“结构化可直传”类型集合
export type StructuredCloneValue =
  | Date
  | RegExp
  | ArrayBuffer
  | DataView
  | Blob
  | File
  | ImageData
  | Map<any, any>
  | Set<any>
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

// 深度 Promise 化：保持结构化直传对象原样；函数返回 Promise；对象与数组递归处理
export type Promisified<T> =
  T extends StructuredCloneValue
    ? T
    : T extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Promisified<Awaited<R>>>
      : T extends ReadonlyArray<any>
        ? { [K in keyof T]: Promisified<T[K]> }
        : T extends Record<string, any>
          ? { [K in keyof T]: Promisified<T[K]> }
          : T

// 服务端选项（原 iframe-rpc-server 中定义）
export type CreateIframeRpcServerOptions = {
  name: string
  handleTtlMs?: number
  sweepIntervalMs?: number
  allowedOrigins?: string[] | ((origin: string) => boolean)
  targetOrigin?: string
}

// 客户端选项（原 iframe-rpc-client 中的匿名 options 类型）
export type CreateIframeRpcClientOptions = {
  timeout?: number
  gcSweepIntervalMs?: number
  releaseOnPageHide?: 'nonPersisted' | 'all' | 'off'
  hideStructure?: boolean
  allowedOrigins?: string[] | ((origin: string) => boolean)
  targetOrigin?: string
}

// 返回值句柄载荷（供客户端/服务端在处理函数返回对象/函数时参考）
export type RpcHandlePayload = {
  __rpc__: 'handle'
  id: string
  kind: 'function' | 'object'
  values?: Record<string, any>
  functions?: string[]
}

