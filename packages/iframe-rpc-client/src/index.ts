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

export type Promisified<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Promisified<Awaited<R>>>
  : T extends Record<string, any>
    ? { [K in keyof T]: Promisified<T[K]> }
    : T

export function createIframeRpcClient<TApi extends Record<string, any>>(name: string, options?: { timeout?: number; gcSweepIntervalMs?: number; releaseOnPageHide?: 'nonPersisted' | 'all' | 'off' }): Promise<Promisified<TApi>> {
  return new Promise((resolve, reject) => {
    let targetWindow: Window | null = null
    let values: Record<string, any> = {}
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
            if (functionSet.has(fullPath)) {
              return (...args: any[]) => {
                const tw = targetWindow
                if (!tw) return Promise.reject(new Error('RPC target not ready'))
                const id = genId()
                const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method: fullPath, args }
                try { console.log(`[rpc-client:${name}] CALL root method=${fullPath} id=${id}`) } catch {}
                return new Promise((resolve, reject) => {
                  pending.set(id, { resolve, reject })
                  tw.postMessage(msg, '*')
                })
              }
            }
            const v = getDeep(values, fullPath)
            if (v !== undefined && v !== null && typeof v === 'object') {
              return createLevelProxy(fullPath)
            }
            if (v !== undefined) return v
            // Even if value not present, still expose nested proxy if there are functions under this path
            if (hasFunctionUnder(fullPath)) return createLevelProxy(fullPath)
            return undefined
          },
        }
      )
      return proxy
    }

    function createScopedProxy(handleId: string, scopedValues: Record<string, any>, scopedFunctions: string[], prefix: string): any {
      const functionSetLocal = new Set<string>(scopedFunctions)
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
            if (functionSetLocal.has(fullPath)) {
              return (...args: any[]) => {
                if (released.has(handleId)) return Promise.reject(new Error(`Handle ${handleId} released`))
                const tw = targetWindow
                if (!tw) return Promise.reject(new Error('RPC target not ready'))
                const id = genId()
                const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method: fullPath, args, handle: handleId }
                try { console.log(`[rpc-client:${name}] CALL handle=${handleId} method=${fullPath} id=${id}`) } catch {}
                return new Promise((resolve, reject) => {
                  pending.set(id, { resolve, reject })
                  tw.postMessage(msg, '*')
                })
              }
            }
            const v = getDeep(scopedValues, fullPath)
            if (v !== undefined && v !== null && typeof v === 'object') {
              return createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
            }
            if (v !== undefined) return v
            const pre = prefix ? prefix + '.' : ''
            if ([...functionSetLocal].some((f) => f === fullPath || f.startsWith(pre + key + '.'))) {
              return createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
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
