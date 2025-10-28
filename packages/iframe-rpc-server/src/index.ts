export type CreateIframeRpcServerOptions = {
  name: string
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

export function createIframeRpcServer<TApi extends Record<string, any>>(api: TApi, options: CreateIframeRpcServerOptions) {
  const { name } = options
  const handles = new Map<string, any>()

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  function isObject(val: any) {
    return val !== null && typeof val === 'object'
  }

  function collectFunctionPaths(obj: any, base: string[] = [], out: string[] = []) {
    for (const key of Object.keys(obj)) {
      const v = obj[key]
      const path = [...base, key]
      if (typeof v === 'function') out.push(path.join('.'))
      else if (isObject(v)) collectFunctionPaths(v, path, out)
    }
    return out
  }

  function cloneValuesOnly(obj: any): any {
    if (typeof obj === 'function') return undefined
    if (!isObject(obj)) return obj
    if (Array.isArray(obj)) return obj.map((item) => cloneValuesOnly(item))
    const out: Record<string, any> = {}
    for (const key of Object.keys(obj)) {
      const v = obj[key]
      if (typeof v === 'function') continue
      out[key] = cloneValuesOnly(v)
    }
    return out
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
        const errMsg = `Handle ${handle} not found`
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'ERROR', id, error: errMsg }
        ;(event.source as Window).postMessage(msg, '*')
        return
      }
      const fn = method ? getDeep(ctx as any, method) : ctx
      if (typeof fn !== 'function') {
        const errMsg = `Method ${method || '<root>'} not found`
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'ERROR', id, error: errMsg }
        source.postMessage(msg, '*')
        return
      }
      try {
        const result = await Promise.resolve(fn(...args))
        const serialized = serializeResult(result)
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'RESULT', id, result: serialized }
        source.postMessage(msg, '*')
      } catch (err) {
        const msg: RpcMessage = { rpc: 'iframe-rpc', name, type: 'ERROR', id, error: serializeError(err) }
        source.postMessage(msg, '*')
      }
      return
    }
  })
}
