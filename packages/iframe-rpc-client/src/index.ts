type RpcMessage =
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

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// 与运行时 isStructuredClonePassThrough 对齐的“结构化可直传”类型集合
type StructuredCloneValue =
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

export type Promisified<T> =
  // 对可结构化直传的对象，保持原样（不递归 Promise 化）
  T extends StructuredCloneValue
    ? T
    : T extends (...args: infer A) => infer R
      // 函数始终返回 Promise（与异步调用一致），但内部返回值做递归处理
      ? (...args: A) => Promise<Promisified<Awaited<R>>>
      // 普通数组做元素级递归
      : T extends ReadonlyArray<any>
        ? { [K in keyof T]: Promisified<T[K]> }
        // 普通对象做属性级递归
        : T extends Record<string, any>
          ? { [K in keyof T]: Promisified<T[K]> }
          : T

export function createIframeRpcClient<TApi extends Record<string, any>>(name: string, options?: { timeout?: number; gcSweepIntervalMs?: number; releaseOnPageHide?: 'nonPersisted' | 'all' | 'off' }): Promise<Promisified<TApi>> {
  return new Promise((resolve, reject) => {
    let targetWindow: Window | null = null
    let values: Record<string, any> = {}
    // 记录值快照中每个对象的“首遇最短路径”，用于循环别名路径的函数解析
    let canonicalIndex: WeakMap<object, string> = new WeakMap()
    const functionSet = new Set<string>()
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
    const released = new Set<string>()
    const timeoutMs = options?.timeout ?? 5000
    const initTimer = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error(`iframe-rpc initialization timeout for name: ${name}`))
    }, timeoutMs)

    const releaseHandle = (handleId: string) => {
      released.add(handleId)
      // 从活跃句柄表中移除，避免后续轮询
      activeHandles.delete(handleId)
      const tw = targetWindow
      if (!tw) return
      const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'RELEASE_HANDLE', handle: handleId }
      try {
        tw.postMessage(msg, '*')
      } catch {
        // ignore release failures
      }
    }

    const FinalReg: FinalizationRegistry<string> | null = typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry((id) => releaseHandle(id)) : null
    const weakRefAvailable = typeof WeakRef !== 'undefined'
    const activeHandles = new Map<string, { weakRef?: WeakRef<any> }>()
    let sweeperTimer: any = null
    const sweepIntervalMs = typeof options?.gcSweepIntervalMs === 'number' ? Math.max(1, options.gcSweepIntervalMs!) : 60000
    const releaseOnPageHide = options?.releaseOnPageHide ?? 'nonPersisted'
    const startWeakRefSweeper = () => {
      if (!weakRefAvailable || sweeperTimer) return
      sweeperTimer = setInterval(() => {
        for (const [id, meta] of activeHandles.entries()) {
          if (released.has(id)) { activeHandles.delete(id); continue }
          const ref = meta.weakRef
          if (!ref) continue
          if (ref.deref() == null) {
            releaseHandle(id)
            activeHandles.delete(id)
          }
        }
      }, sweepIntervalMs)
    }
    const onShutdown = () => {
      for (const id of activeHandles.keys()) {
        if (!released.has(id)) releaseHandle(id)
      }
      activeHandles.clear()
    }
    const pagehideHandler = (ev: any) => {
      const persisted = !!(ev && ev.persisted)
      if (releaseOnPageHide === 'off') return
      if (releaseOnPageHide === 'all' || (releaseOnPageHide === 'nonPersisted' && !persisted)) {
        onShutdown()
      }
    }

    function getDeep(obj: any, path: string) {
      if (!path) return obj
      const parts = path.split('.')
      let cur = obj
      for (const p of parts) {
        if (!cur) return undefined
        cur = cur[p]
      }
      return cur
    }

    function brandTag(val: any): string {
      return Object.prototype.toString.call(val)
    }
    function isTypedArray(val: any): boolean {
      return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(val)
    }
    function isStructuredClonePassThrough(val: any): boolean {
      if (!val || typeof val !== 'object') return false
      const tag = brandTag(val)
      if (tag === '[object Date]' || tag === '[object RegExp]' || tag === '[object ArrayBuffer]' || tag === '[object DataView]' || tag === '[object Blob]' || tag === '[object File]' || tag === '[object ImageData]') return true
      if (tag === '[object Map]' || tag === '[object Set]') return true
      if (isTypedArray(val)) return true
      return false
    }

    // 为循环引用构建对象到最短路径的索引（仅遍历普通对象/数组）
    function buildCanonicalIndex(root: any): WeakMap<object, string> {
      const idx = new WeakMap<object, string>()
      const visited = new WeakSet<object>()
      function walk(obj: any, path: string) {
        if (!obj || typeof obj !== 'object') return
        // 内置结构化直传对象按值存在，不遍历其内部
        if (isStructuredClonePassThrough(obj)) {
          if (!idx.has(obj as object)) idx.set(obj as object, path)
          return
        }
        if (visited.has(obj as object)) return
        visited.add(obj as object)
        if (!idx.has(obj as object)) idx.set(obj as object, path)
        if (Array.isArray(obj)) {
          for (let i = 0; i < obj.length; i++) {
            walk(obj[i], path ? `${path}.${i}` : String(i))
          }
        } else {
          for (const key of Object.keys(obj)) {
            walk(obj[key], path ? `${path}.${key}` : key)
          }
        }
      }
      walk(root, '')
      return idx
    }

    function resolveAliasFunctionPath(parentPath: string, key: string): string | null {
      // 精确路径存在则直接使用
      const direct = parentPath ? `${parentPath}.${key}` : key
      if (functionSet.has(direct)) return direct
      // 尝试通过循环别名映射到“首遇最短路径”
      const parentObj = getDeep(values, parentPath)
      if (!parentObj || typeof parentObj !== 'object') return null
      const canon = canonicalIndex.get(parentObj as object)
      if (!canon && canon !== '') return null
      const candidate = canon ? `${canon}.${key}` : key
      return functionSet.has(candidate) ? candidate : null
    }

    function hasFunctionUnder(prefix: string) {
      const pre = prefix ? prefix + '.' : ''
      for (const f of functionSet) {
        if (f === prefix || f.startsWith(pre)) return true
      }
      return false
    }

    function createLevelProxy(prefix: string): any {
      const proxy = new Proxy(
        {},
        {
          get(_target, prop) {
            const key = String(prop)
            const fullPath = prefix ? `${prefix}.${key}` : key
            // 支持循环别名：在 functionSet 中未出现的别名路径，尝试映射到最短路径
            const resolvedFnPath = resolveAliasFunctionPath(prefix, key)
            if (resolvedFnPath) {
              return (...args: any[]) => {
                const tw = targetWindow
                if (!tw) return Promise.reject(new Error('RPC target not ready'))
                const id = genId()
                const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method: resolvedFnPath, args }
                try { console.log(`[rpc-client:${name}] CALL root method=${resolvedFnPath} id=${id}`) } catch {}
                return new Promise((resolve, reject) => {
                  pending.set(id, { resolve, reject })
                  tw.postMessage(msg, '*')
                })
              }
            }
            const v = getDeep(values, fullPath)
            if (v !== undefined) {
              if (v !== null && typeof v === 'object') {
                if (isStructuredClonePassThrough(v)) return v
                return createLevelProxy(fullPath)
              }
              return v
            }
            // Even if value not present, still expose nested proxy if there are functions under this path
            // 别名路径的函数存在于其“最短路径”下时也暴露嵌套代理
            if (hasFunctionUnder(fullPath)) return createLevelProxy(fullPath)
            const parentObj = getDeep(values, prefix)
            if (parentObj && typeof parentObj === 'object') {
              const canon = canonicalIndex.get(parentObj as object)
              const aliasPrefix = canon ? `${canon}.${key}` : key
              if (hasFunctionUnder(aliasPrefix)) return createLevelProxy(fullPath)
            }
            return undefined
          },
        }
      )
      return proxy
    }

    function createScopedProxy(handleId: string, scopedValues: Record<string, any>, scopedFunctions: string[], prefix: string): any {
      const functionSetLocal = new Set<string>(scopedFunctions)
      const canonicalIndexLocal = buildCanonicalIndex(scopedValues)
      const target: Record<string, any> = {}
      const proxy = new Proxy(
        target,
        {
          get(_target, prop) {
            const key = String(prop)
            const fullPath = prefix ? `${prefix}.${key}` : key
            if (key === '__release') {
              return () => releaseHandle(handleId)
            }
            // 支持循环别名：在本地 functionSetLocal 未出现的别名路径，尝试映射到最短路径
            const resolveLocal = () => {
              const direct = fullPath
              if (functionSetLocal.has(direct)) return direct
              const parentObj = getDeep(scopedValues, prefix)
              if (!parentObj || typeof parentObj !== 'object') return null
              const canon = canonicalIndexLocal.get(parentObj as object)
              if (!canon && canon !== '') return null
              const candidate = canon ? `${canon}.${key}` : key
              return functionSetLocal.has(candidate) ? candidate : null
            }
            const resolvedFnPath = resolveLocal()
            if (resolvedFnPath) {
              return (...args: any[]) => {
                if (released.has(handleId)) return Promise.reject(new Error(`Handle ${handleId} released`))
                const tw = targetWindow
                if (!tw) return Promise.reject(new Error('RPC target not ready'))
                const id = genId()
                const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method: resolvedFnPath, args, handle: handleId }
                try { console.log(`[rpc-client:${name}] CALL handle=${handleId} method=${resolvedFnPath} id=${id}`) } catch {}
                return new Promise((resolve, reject) => {
                  pending.set(id, { resolve, reject })
                  tw.postMessage(msg, '*')
                })
              }
            }
            const v = getDeep(scopedValues, fullPath)
            if (v !== undefined) {
              if (v !== null && typeof v === 'object') {
                if (isStructuredClonePassThrough(v)) return v
                return createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
              }
              return v
            }
            const pre = prefix ? prefix + '.' : ''
            // 针对别名路径，检查其“最短路径”下是否仍有函数存在
            if ([...functionSetLocal].some((f) => f === fullPath || f.startsWith(pre + key + '.'))) {
              return createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
            }
            const parentObj = getDeep(scopedValues, prefix)
            if (parentObj && typeof parentObj === 'object') {
              const canon = canonicalIndexLocal.get(parentObj as object)
              const aliasPrefix = canon ? `${canon}.${key}` : key
              const preAlias = aliasPrefix ? aliasPrefix + '.' : ''
              if ([...functionSetLocal].some((f) => f === aliasPrefix || f.startsWith(preAlias))) {
                return createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
              }
            }
            return undefined
          },
        }
      )
      // 自动释放：FinalizationRegistry 优先，WeakRef 作为降级轮询
      if (FinalReg) FinalReg.register(proxy, handleId)
      if (weakRefAvailable) activeHandles.set(handleId, { weakRef: new WeakRef(proxy) })
      startWeakRefSweeper()
      return proxy
    }

    function fromResultPayload(payload: any): any {
      if (!payload || typeof payload !== 'object') return payload
      if (payload.__rpc__ === 'handle') {
        const id = payload.id as string
        const kind = payload.kind as 'function' | 'object' | undefined
        const vals = payload.values || {}
        const funcs = payload.functions || []
        if (kind === 'function') {
          const fn: any = (...args: any[]) => {
            if (released.has(id)) return Promise.reject(new Error(`Handle ${id} released`))
            const tw = targetWindow
            if (!tw) return Promise.reject(new Error('RPC target not ready'))
            const callId = genId()
            const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id: callId, method: '', args, handle: id }
            return new Promise((resolve, reject) => {
              pending.set(callId, { resolve, reject })
              tw.postMessage(msg, '*')
            })
          }
          // manual release method
          fn.__release = () => releaseHandle(id)
          // auto release on GC if supported
          if (FinalReg) {
            try { FinalReg.register(fn, id) } catch { /* ignore */ }
          }
          if (weakRefAvailable) activeHandles.set(id, { weakRef: new WeakRef(fn) })
          startWeakRefSweeper()
          return fn
        }
        // default to object proxy
        return createScopedProxy(id, vals, funcs, '')
      }
      return payload
    }

    const handler = (event: MessageEvent) => {
      const data: RpcMessage | any = event.data
      if (!data || data.rpc !== 'iframe-rpc' || data.name !== name) return

      if (data.type === 'READY') {
        clearTimeout(initTimer)
        targetWindow = event.source as Window | null
        values = data.payload.values || {}
        canonicalIndex = buildCanonicalIndex(values)
        functionSet.clear()
        for (const fnName of data.payload.functions || []) functionSet.add(fnName)
        resolve(createLevelProxy('') as Promisified<TApi>)
        return
      }

      if (data.type === 'RESULT') {
        const p = pending.get(data.id)
        if (p) {
          p.resolve(fromResultPayload(data.result))
          pending.delete(data.id)
        }
        return
      }

      if (data.type === 'ERROR') {
        try { console.log(`[rpc-client:${name}] ERROR id=${data.id} msg=${data.error} hasPending=${pending.has(data.id)}`) } catch {}
        const p = pending.get(data.id)
        if (p) {
          p.reject(new Error(data.error))
          pending.delete(data.id)
        }
        return
      }

      if (data.type === 'INIT_ERROR') {
        clearTimeout(initTimer)
        window.removeEventListener('message', handler)
        reject(new Error(data.error))
        return
      }
    }

    window.addEventListener('message', handler)
    // 页面生命周期兜底释放
    try {
      window.addEventListener('beforeunload', onShutdown)
      window.addEventListener('pagehide', pagehideHandler)
    } catch {}

    // 主要依赖服务端 createIframeRpcServer 的 READY 广播，无需额外 GET
  })
}
