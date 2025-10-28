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

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export type Promisified<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Promisified<Awaited<R>>>
  : T extends Record<string, any>
    ? { [K in keyof T]: Promisified<T[K]> }
    : T

export function createIframeRpcClient<TApi extends Record<string, any>>(name: string, options?: { timeout?: number }): Promise<Promisified<TApi>> {
  return new Promise((resolve, reject) => {
    let targetWindow: Window | null = null
    let values: Record<string, any> = {}
    const functionSet = new Set<string>()
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
    const timeoutMs = options?.timeout ?? 5000
    const initTimer = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error(`iframe-rpc initialization timeout for name: ${name}`))
    }, timeoutMs)

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
                if (!targetWindow) return Promise.reject(new Error('RPC target not ready'))
                const id = genId()
                const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method: fullPath, args }
                targetWindow.postMessage(msg, '*')
                return new Promise((resolve, reject) => {
                  pending.set(id, { resolve, reject })
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
      const proxy = new Proxy(
        {},
        {
          get(_target, prop) {
            const key = String(prop)
            const fullPath = prefix ? `${prefix}.${key}` : key
            if (functionSetLocal.has(fullPath)) {
              return (...args: any[]) => {
                if (!targetWindow) return Promise.reject(new Error('RPC target not ready'))
                const id = genId()
                const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id, method: fullPath, args, handle: handleId }
                targetWindow.postMessage(msg, '*')
                return new Promise((resolve, reject) => {
                  pending.set(id, { resolve, reject })
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
          return (...args: any[]) => {
            if (!targetWindow) return Promise.reject(new Error('RPC target not ready'))
            const callId = genId()
            const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'CALL', id: callId, method: '', args, handle: id }
            targetWindow.postMessage(msg, '*')
            return new Promise((resolve, reject) => {
              pending.set(callId, { resolve, reject })
            })
          }
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

    // 主要依赖服务端 createIframeRpcServer 的 READY 广播，无需额外 GET
  })
}
