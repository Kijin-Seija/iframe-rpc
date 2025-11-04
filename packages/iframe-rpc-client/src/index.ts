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

export function createIframeRpcClient<TApi extends Record<string, any>>(name: string, options?: { timeout?: number; gcSweepIntervalMs?: number; releaseOnPageHide?: 'nonPersisted' | 'all' | 'off'; hideStructure?: boolean; allowedOrigins?: string[] | ((origin: string) => boolean); targetOrigin?: string }): Promise<Promisified<TApi>> {
  return new Promise((resolve, reject) => {
    let targetWindow: Window | null = null
    let serverOrigin: string | null = null
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

    const destinationOrigin = () => {
      if (options?.targetOrigin) return options.targetOrigin
      if (serverOrigin) return serverOrigin
      return '*'
    }

    const isOriginAllowed = (() => {
      if (!options?.allowedOrigins) return (_origin: string) => true
      if (typeof options.allowedOrigins === 'function') return options.allowedOrigins
      const set = new Set(options.allowedOrigins)
      return (origin: string) => set.has(origin)
    })()

    const releaseHandle = (handleId: string) => {
      released.add(handleId)
      // 从活跃句柄表中移除，避免后续轮询
      activeHandles.delete(handleId)
      const tw = targetWindow
      if (!tw) return
      const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'RELEASE_HANDLE', handle: handleId }
      try {
        tw.postMessage(msg, destinationOrigin())
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

    // 默认启用物化；设置 hideStructure: true 可关闭物化（最高性能/更严格结构隐藏）
    const materializeStructure = options?.hideStructure === true ? false : true

    // 物化模式已不再需要枚举键的辅助函数

    function makeRootFunctionProxy(method: string) {
      return (...args: any[]) => {
        const tw = targetWindow
        if (!tw) return Promise.reject(new Error('RPC target not ready'))
        const id = genId()
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method, args }
        try { console.log(`[rpc-client:${name}] CALL root method=${method} id=${id}`) } catch {}
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          tw.postMessage(msg, destinationOrigin())
        })
      }
    }

    function readRootValue(prefix: string, key: string): any {
      const fullPath = prefix ? `${prefix}.${key}` : key
      const resolvedFnPath = resolveAliasFunctionPath(prefix, key)
      if (resolvedFnPath) return makeRootFunctionProxy(resolvedFnPath)
      const v = getDeep(values, fullPath)
      if (v !== undefined) {
        if (v !== null && typeof v === 'object') {
          if (isStructuredClonePassThrough(v)) return v
          return createLevelProxy(fullPath)
        }
        return v
      }
      // 函数在别名的最短路径下，仍暴露嵌套代理
      if (hasFunctionUnder(fullPath)) return createLevelProxy(fullPath)
      const parentObj = getDeep(values, prefix)
      if (parentObj && typeof parentObj === 'object') {
        const canon = canonicalIndex.get(parentObj as object)
        const aliasPrefix = canon ? `${canon}.${key}` : key
        if (hasFunctionUnder(aliasPrefix)) return createLevelProxy(fullPath)
      }
      return undefined
    }

    function createLevelProxy(prefix: string): any {
      const handler: ProxyHandler<any> = {
        get(_target, prop) {
          const key = String(prop)
          return readRootValue(prefix, key)
        },
      }
      return new Proxy({}, handler)
    }

    // 物化模式：构建真实对象树并将函数作为实际属性挂载
    function createMaterializedRoot(): any {
      // 从值快照深度克隆为可枚举对象，保留循环结构
      const srcRoot = values
      const mapSrcToDest = new WeakMap<object, any>()
      function cloneNode(src: any): any {
        if (!src || typeof src !== 'object') return src
        if (isStructuredClonePassThrough(src)) return src
        const hit = mapSrcToDest.get(src as object)
        if (hit) return hit
        let dest: any
        if (Array.isArray(src)) {
          dest = []
          mapSrcToDest.set(src as object, dest)
          for (let i = 0; i < src.length; i++) {
            dest[i] = cloneNode(src[i])
          }
        } else {
          dest = {}
          mapSrcToDest.set(src as object, dest)
          for (const k of Object.keys(src)) {
            dest[k] = cloneNode(src[k])
          }
        }
        return dest
      }
      const root = cloneNode(srcRoot)

      // 回退：当某函数父路径不在值快照中时，在物化对象上按需创建中间节点
      function ensureTargetForParentPath(parentPath: string): any {
        if (!parentPath) return root
        const srcParent = getDeep(values, parentPath)
        if (srcParent && typeof srcParent === 'object' && !isStructuredClonePassThrough(srcParent)) {
          const dest = mapSrcToDest.get(srcParent as object)
          if (dest) return dest
        }
        const parts = parentPath.split('.')
        let cur: any = root
        let curPath = ''
        for (let i = 0; i < parts.length; i++) {
          const seg = parts[i]
          curPath = curPath ? `${curPath}.${seg}` : seg
          const nextSrc = getDeep(values, curPath)
          if (Array.isArray(cur)) {
            const idx = Number(seg)
            if (!Number.isNaN(idx)) {
              if (cur[idx] === undefined || cur[idx] === null || typeof cur[idx] !== 'object') cur[idx] = {}
              cur = cur[idx]
              continue
            }
            if (!(cur as any)[seg] || typeof (cur as any)[seg] !== 'object') (cur as any)[seg] = {}
            cur = (cur as any)[seg]
          } else {
            if (!(cur as any)[seg] || typeof (cur as any)[seg] !== 'object') {
              (cur as any)[seg] = Array.isArray(nextSrc) ? [] : {}
            }
            cur = (cur as any)[seg]
          }
        }
        return cur
      }

      for (const method of functionSet) {
        const idx = method.lastIndexOf('.')
        const parentPath = idx >= 0 ? method.slice(0, idx) : ''
        const leafKey = idx >= 0 ? method.slice(idx + 1) : method
        const parentObj = ensureTargetForParentPath(parentPath)
        parentObj[leafKey] = makeRootFunctionProxy(method)
      }

      return root
    }

    function createScopedProxy(handleId: string, scopedValues: Record<string, any>, scopedFunctions: string[], prefix: string): any {
      const functionSetLocal = new Set<string>(scopedFunctions)
      const canonicalIndexLocal = buildCanonicalIndex(scopedValues)
      const target: Record<string, any> = {}

      function makeHandleFunctionProxy(method: string) {
        return (...args: any[]) => {
          if (released.has(handleId)) return Promise.reject(new Error(`Handle ${handleId} released`))
          const tw = targetWindow
          if (!tw) return Promise.reject(new Error('RPC target not ready'))
          const id = genId()
          const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method, args, handle: handleId }
          try { console.log(`[rpc-client:${name}] CALL handle=${handleId} method=${method} id=${id}`) } catch {}
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject })
            tw.postMessage(msg, destinationOrigin())
          })
        }
      }

      function readScopedValue(key: string): any {
        const fullPath = prefix ? `${prefix}.${key}` : key
        if (key === '__release') return () => releaseHandle(handleId)
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
        if (resolvedFnPath) return makeHandleFunctionProxy(resolvedFnPath)
        const v = getDeep(scopedValues, fullPath)
        if (v !== undefined) {
          if (v !== null && typeof v === 'object') {
            if (isStructuredClonePassThrough(v)) return v
            return createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
          }
          return v
        }
        const pre = prefix ? prefix + '.' : ''
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
      }

      const handler: ProxyHandler<any> = {
        get(_target, prop) {
          return readScopedValue(String(prop))
        },
      }
      const proxy = new Proxy(target, handler)
      // 自动释放：FinalizationRegistry 优先，WeakRef 作为降级轮询
      if (FinalReg) FinalReg.register(proxy, handleId)
      if (weakRefAvailable) activeHandles.set(handleId, { weakRef: new WeakRef(proxy) })
      startWeakRefSweeper()
      return proxy
    }

    // 物化模式：将返回值句柄对象物化为真实对象树，并挂载函数属性
    function createMaterializedHandle(handleId: string, scopedValues: Record<string, any>, scopedFunctions: string[]): any {
      const functionSetLocal = new Set<string>(scopedFunctions)
      const mapSrcToDest = new WeakMap<object, any>()

      function cloneNode(src: any): any {
        if (!src || typeof src !== 'object') return src
        if (isStructuredClonePassThrough(src)) return src
        const hit = mapSrcToDest.get(src as object)
        if (hit) return hit
        let dest: any
        if (Array.isArray(src)) {
          dest = []
          mapSrcToDest.set(src as object, dest)
          for (let i = 0; i < src.length; i++) {
            dest[i] = cloneNode(src[i])
          }
        } else {
          dest = {}
          mapSrcToDest.set(src as object, dest)
          for (const k of Object.keys(src)) {
            dest[k] = cloneNode(src[k])
          }
        }
        return dest
      }

      const root = cloneNode(scopedValues)

      function ensureTargetForParentPathLocal(parentPath: string): any {
        if (!parentPath) return root
        const srcParent = getDeep(scopedValues, parentPath)
        if (srcParent && typeof srcParent === 'object' && !isStructuredClonePassThrough(srcParent)) {
          const dest = mapSrcToDest.get(srcParent as object)
          if (dest) return dest
        }
        const parts = parentPath.split('.')
        let cur: any = root
        let curPath = ''
        for (let i = 0; i < parts.length; i++) {
          const seg = parts[i]
          curPath = curPath ? `${curPath}.${seg}` : seg
          const nextSrc = getDeep(scopedValues, curPath)
          if (Array.isArray(cur)) {
            const idx = Number(seg)
            if (!Number.isNaN(idx)) {
              if (cur[idx] === undefined || cur[idx] === null || typeof cur[idx] !== 'object') cur[idx] = {}
              cur = cur[idx]
              continue
            }
            if (!(cur as any)[seg] || typeof (cur as any)[seg] !== 'object') (cur as any)[seg] = {}
            cur = (cur as any)[seg]
          } else {
            if (!(cur as any)[seg] || typeof (cur as any)[seg] !== 'object') {
              (cur as any)[seg] = Array.isArray(nextSrc) ? [] : {}
            }
            cur = (cur as any)[seg]
          }
        }
        return cur
      }

      function makeHandleFunctionProxy(method: string) {
        return (...args: any[]) => {
          if (released.has(handleId)) return Promise.reject(new Error(`Handle ${handleId} released`))
          const tw = targetWindow
          if (!tw) return Promise.reject(new Error('RPC target not ready'))
          const id = genId()
          const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method, args, handle: handleId }
          try { console.log(`[rpc-client:${name}] CALL handle=${handleId} method=${method} id=${id}`) } catch {}
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject })
            tw.postMessage(msg, '*')
          })
        }
      }

      for (const method of functionSetLocal) {
        const idx = method.lastIndexOf('.')
        const parentPath = idx >= 0 ? method.slice(0, idx) : ''
        const leafKey = idx >= 0 ? method.slice(idx + 1) : method
        const parentObj = ensureTargetForParentPathLocal(parentPath)
        parentObj[leafKey] = makeHandleFunctionProxy(method)
      }

      ;(root as any).__release = () => releaseHandle(handleId)
      if (FinalReg) {
        try { FinalReg.register(root, handleId) } catch {}
      }
      if (weakRefAvailable) activeHandles.set(handleId, { weakRef: new WeakRef(root) })
      startWeakRefSweeper()
      return root
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
                tw.postMessage(msg, destinationOrigin())
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
        // object handle：根据是否物化返回物化对象或懒代理
        if (materializeStructure) {
          return createMaterializedHandle(id, vals, funcs)
        }
        return createScopedProxy(id, vals, funcs, '')
      }
      return payload
    }

    const handler = (event: MessageEvent) => {
      // 校验来源 origin（若配置了 allowedOrigins）
      if (!isOriginAllowed(event.origin)) return
      const data: RpcMessage | any = event.data
      if (!data || data.rpc !== 'iframe-rpc' || data.name !== name) return

      if (data.type === 'READY') {
        clearTimeout(initTimer)
        targetWindow = event.source as Window | null
        serverOrigin = event.origin || null
        values = data.payload.values || {}
        canonicalIndex = buildCanonicalIndex(values)
        functionSet.clear()
        for (const fnName of data.payload.functions || []) functionSet.add(fnName)
        if (materializeStructure) {
          resolve(createMaterializedRoot() as Promisified<TApi>)
        } else {
          resolve(createLevelProxy('') as Promisified<TApi>)
        }
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
