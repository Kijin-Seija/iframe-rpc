export type CreateIframeRpcServerOptions = {
  name: string
  // Idle time-to-live (TTL) for returned handles (functions/objects). Defaults to 10 minutes.
  handleTtlMs?: number
  // How often to run the sweeping task that evicts expired handles. Defaults to 60 seconds.
  sweepIntervalMs?: number
}

type RpcMessage =
  | {
      rpc: 'iframe-rpc'
      name: string
      type: 'GET' | 'READY'
      payload?: {
        values: Record<string, any>
        functions: string[]
      }
    }
  | {
      rpc: 'iframe-rpc'
      name: string
      type: 'CALL'
      id: string
      method: string
      args: any[]
      // optional handle id for calling functions on returned objects/functions
      handle?: string
    }
  | {
      rpc: 'iframe-rpc'
      name: string
      type: 'RESULT' | 'ERROR'
      id: string
      result?: any
      error?: string
    }
  | {
      rpc: 'iframe-rpc'
      name: string
      type: 'INIT_ERROR'
      error: string
    }
  | {
      rpc: 'iframe-rpc'
      name: string
      type: 'RELEASE_HANDLE'
      handle: string
    }

export function createIframeRpcServer<TApi extends Record<string, any>>(api: TApi, options: CreateIframeRpcServerOptions) {
  const { name } = options
  const handles = new Map<string, any>()
  const handleMeta = new Map<string, { lastUsed: number }>()

  const DEFAULT_TTL = 10 * 60 * 1000 // 10 minutes
  const DEFAULT_SWEEP = 60 * 1000 // 60 seconds
  const ttlMs = Math.max(0, options.handleTtlMs ?? DEFAULT_TTL)
  const sweepMs = Math.max(0, options.sweepIntervalMs ?? DEFAULT_SWEEP)

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  function isObject(val: any) {
    return val !== null && typeof val === 'object'
  }

  function brandTag(val: any): string {
    return Object.prototype.toString.call(val)
  }

  function isTypedArray(val: any): boolean {
    return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(val)
  }

  function isStructuredClonePassThrough(val: any): boolean {
    const tag = brandTag(val)
    // Broadly supported structured-clone types
    if (tag === '[object Date]' || tag === '[object RegExp]' || tag === '[object ArrayBuffer]' || tag === '[object DataView]' || tag === '[object Blob]' || tag === '[object File]' || tag === '[object ImageData]') {
      return true
    }
    if (tag === '[object Map]' || tag === '[object Set]') return true
    if (isTypedArray(val)) return true
    return false
  }

  // 列出“可读取”的键：
  // - 包含自身可枚举属性（Object.keys）
  // - 包含自身的非枚举 accessor 属性（descriptor.get 存在）
  // - 包含原型链上的 accessor 属性（descriptor.get 存在，排除 constructor）
  // 说明：不把原型链上的数据属性/方法（value:function）作为值快照键，避免把类方法误当作普通字段；
  // getter 会以“当前值”被读取并进入值快照。
  function listReadableKeys(obj: any): string[] {
    if (!isObject(obj)) return []
    // 结构化直传的内置对象不遍历其键
    if (isStructuredClonePassThrough(obj)) return []
    const set = new Set<string>()
    // 自身可枚举属性
    for (const k of Object.keys(obj)) set.add(k)
    // 自身非枚举 accessor 属性
    try {
      for (const k of Object.getOwnPropertyNames(obj)) {
        if (set.has(k)) continue
        const desc = Object.getOwnPropertyDescriptor(obj, k)
        if (desc && typeof desc.get === 'function') set.add(k)
      }
    } catch {}
    // 原型链上的 accessor 属性（排除 Object.prototype）
    try {
      let proto = Object.getPrototypeOf(obj)
      while (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
          if (k === 'constructor' || set.has(k)) continue
          const desc = Object.getOwnPropertyDescriptor(proto, k)
          if (desc && typeof desc.get === 'function') set.add(k)
        }
        proto = Object.getPrototypeOf(proto)
      }
    } catch {}
    return Array.from(set)
  }

  // 为函数路径收集列出候选键：
  // - 自身可枚举属性 + accessor（与 listReadableKeys 一致）
  // - 原型链上的“数据属性为函数”的键（排除 constructor、排除 Object.prototype）
  function listFunctionKeysForCollect(obj: any): string[] {
    if (!isObject(obj)) return []
    if (isStructuredClonePassThrough(obj)) return []
    const set = new Set<string>()
    for (const k of listReadableKeys(obj)) set.add(k)
    try {
      let proto = Object.getPrototypeOf(obj)
      while (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
          if (k === 'constructor' || set.has(k)) continue
          const desc = Object.getOwnPropertyDescriptor(proto, k)
          if (desc && typeof desc.value === 'function') set.add(k)
        }
        proto = Object.getPrototypeOf(proto)
      }
    } catch {}
    return Array.from(set)
  }

  function collectFunctionPaths(obj: any, base: string[] = [], out: string[] = [], visited: WeakSet<object> = new WeakSet()) {
    if (!isObject(obj)) return out
    // 避免循环引用导致的无限递归
    if (visited.has(obj)) return out
    visited.add(obj as object)
    // 遍历自身键、accessor 以及原型链上的方法键
    for (const key of listFunctionKeysForCollect(obj)) {
      let v: any
      try { v = Reflect.get(obj as any, key) } catch { continue }
      const path = [...base, key]
      if (typeof v === 'function') out.push(path.join('.'))
      else if (isObject(v)) collectFunctionPaths(v, path, out, visited)
    }
    return out
  }

  function cloneValuesOnly(obj: any, seen: WeakMap<object, any> = new WeakMap()): any {
    if (typeof obj === 'function') return undefined
    if (!isObject(obj)) return obj
    // Structured-clone builtins: preserve brand, sanitize entries where applicable
    if (isStructuredClonePassThrough(obj)) {
      const tag = brandTag(obj)
      // 处理循环引用：复用已克隆对象/占位
      const existing = seen.get(obj as object)
      if (existing) return existing
      if (tag === '[object Map]') {
        const outMap = new Map<any, any>()
        seen.set(obj as object, outMap)
        ;(obj as Map<any, any>).forEach((v, k) => {
          const ck = cloneValuesOnly(k, seen)
          const cv = cloneValuesOnly(v, seen)
          outMap.set(ck, cv)
        })
        return outMap
      }
      if (tag === '[object Set]') {
        const outSet = new Set<any>()
        seen.set(obj as object, outSet)
        ;(obj as Set<any>).forEach((v) => {
          const cv = cloneValuesOnly(v, seen)
          outSet.add(cv)
        })
        return outSet
      }
      // TypedArray / ArrayBuffer / DataView / Date / RegExp / Blob / File / ImageData: pass-through
      seen.set(obj as object, obj)
      return obj
    }
    // 处理循环引用：复用已克隆对象
    const existing = seen.get(obj as object)
    if (existing) return existing
    if (Array.isArray(obj)) {
      const outArr: any[] = []
      seen.set(obj as object, outArr)
      for (let i = 0; i < obj.length; i++) {
        outArr[i] = cloneValuesOnly(obj[i], seen)
      }
      return outArr
    }
    const outObj: Record<string, any> = {}
    seen.set(obj as object, outObj)
    // 自身枚举属性 + getter（自身与原型链）
    for (const key of listReadableKeys(obj)) {
      let v: any
      try { v = Reflect.get(obj as any, key) } catch { continue }
      if (typeof v === 'function') continue
      outObj[key] = cloneValuesOnly(v, seen)
    }
    return outObj
  }

  const values: Record<string, any> = cloneValuesOnly(api)
  const functions: string[] = collectFunctionPaths(api)

  function serializeError(err: unknown): string {
    if (err instanceof Error) return err.message
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }

  function sendReady(to: Window) {
    const msg: RpcMessage = {
      rpc: 'iframe-rpc',
      name,
      type: 'READY',
      payload: { values, functions },
    }
    to.postMessage(msg, '*')
  }

  function serializeResult(result: any): any {
    // If result is a function or contains functions, wrap it as a handle
    const hasFunctions = typeof result === 'function' || (isObject(result) && collectFunctionPaths(result).length > 0)
    if (!hasFunctions) return result
    const id = genId()
    handles.set(id, result)
    handleMeta.set(id, { lastUsed: Date.now() })
    if (typeof result === 'function') {
      return { __rpc__: 'handle', id, kind: 'function' }
    }
    return {
      __rpc__: 'handle',
      id,
      kind: 'object',
      values: cloneValuesOnly(result),
      functions: collectFunctionPaths(result),
    }
  }

  // 初始广播：通知父窗口此 RPC 服务已就绪
  try {
    if (window.parent && window.parent !== window) {
      sendReady(window.parent)
    }
  } catch (err) {
    try {
      if (window.parent && window.parent !== window) {
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'INIT_ERROR', error: serializeError(err) }
        window.parent.postMessage(msg, '*')
      }
    } catch {
      // ignore
    }
  }

  window.addEventListener('message', async (event: MessageEvent) => {
    const data: RpcMessage | any = event.data
    if (!data || data.rpc !== 'iframe-rpc' || data.name !== name) return

    // 仅处理来自父窗口的请求
    const source = event.source as Window | null
    if (!source) return

    if (data.type === 'GET') {
      sendReady(source)
      return
    }

    if (data.type === 'CALL') {
      const { id, method, args, handle } = data
      function getDeep(obj: any, path: string) {
        const parts = path.split('.')
        let cur = obj
        for (const p of parts) {
          if (!cur) return undefined
          cur = cur[p]
        }
        return cur
      }
      // Determine call context: root API or a returned handle
      const ctx = handle ? handles.get(handle) : api
      if (handle && !ctx) {
        try { console.log(`[rpc-server:${name}] call on missing handle ${handle}`) } catch {}
        const errMsg = `Handle ${handle} not found`
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'ERROR', id, error: errMsg }
        source.postMessage(msg, '*')
        return
      }
      // Update last-used timestamp for handle on every call
      if (handle) {
        const meta = handleMeta.get(handle)
        if (meta) meta.lastUsed = Date.now()
      }
      let fn: any
      let callThis: any
      if (method) {
        const parts = method.split('.')
        const last = parts.pop()!
        const parentPath = parts.join('.')
        const target = parentPath ? getDeep(ctx as any, parentPath) : ctx
        fn = target ? (target as any)[last] : undefined
        callThis = target
      } else {
        fn = ctx
        callThis = undefined
      }
      if (typeof fn !== 'function') {
        const errMsg = `Method ${method || '<root>'} not found`
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'ERROR', id, error: errMsg }
        source.postMessage(msg, '*')
        return
      }
      try {
        const result = await Promise.resolve(fn.apply(callThis, args))
        const serialized = serializeResult(result)
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'RESULT', id, result: serialized }
        source.postMessage(msg, '*')
      } catch (err) {
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'ERROR', id, error: serializeError(err) }
        source.postMessage(msg, '*')
      }
      return
    }

    if (data.type === 'RELEASE_HANDLE') {
      const id = data.handle
      if (id) {
        handles.delete(id)
        handleMeta.delete(id)
      }
      return
    }
  })

  // Periodic sweeper to evict idle handles based on TTL
  if (ttlMs > 0 && sweepMs > 0) {
    setInterval(() => {
      const now = Date.now()
      for (const [id, meta] of handleMeta.entries()) {
        if (now - meta.lastUsed > ttlMs) {
          try { console.log(`[rpc-server:${name}] evict handle ${id} due to ttl ${ttlMs}ms`) } catch {}
          handleMeta.delete(id)
          handles.delete(id)
        }
      }
    }, sweepMs)
  }
}
