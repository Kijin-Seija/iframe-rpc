import type { RpcMessage, Promisified, CreateIframeRpcClientOptions } from '../../../shared/types.ts'
export type { Promisified, CreateIframeRpcClientOptions } from '../../../shared/types.ts'
import { getDeep, isStructuredClonePassThrough, buildCanonicalIndex, genId } from '../../../shared/utils.ts'

/**
 * Iframe RPC 客户端：与 iframe 或窗口中的服务端进行消息通信，
 * 返回远程 API 的代理对象，支持懒代理（非物化）与物化两种模式，
 * 并负责句柄生命周期管理与来源校验。
 *
 * TApi 为服务端暴露的远程 API 形状。
 */

export class IframeRpcClient<TApi extends Record<string, any>> {
  /** 客户端名称（通道标识），用于消息匹配 */
  private name: string
  /** 构造入参配置 */
  private options?: CreateIframeRpcClientOptions
  /** 服务端对端窗口对象（iframe.contentWindow 或同窗其他窗口），握手后填充 */
  private targetWindow: Window | null = null
  /** 服务端实际 origin（由 READY 消息确认），用于安全校验与消息发送 */
  private serverOrigin: string | null = null
  /** 远端值树的快照，用于物化或懒代理的基础数据 */
  private values: Record<string, any> = {}
  /** 将对象实例映射到其规范路径，避免循环与别名歧义 */
  private canonicalIndex: WeakMap<object, string> = new WeakMap()
  /** 远端可调用函数的路径集合，用于可见性判断与代理生成 */
  private functionSet: Set<string> = new Set()
  /** 以请求 id 为键的未决 promise 记录，等待 RESULT/ERROR 回包 */
  private pending: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }> = new Map()
  /** 已显式或自动释放的句柄 id 集合，避免重复释放 */
  private released: Set<string> = new Set()
  /** FinalizationRegistry 实例（若可用），在代理 GC 时触发远端句柄释放 */
  private FinalReg: FinalizationRegistry<string> | null = typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry((id) => this.releaseHandle(id)) : null
  /** 环境是否支持 WeakRef；配合 sweeper 检测代理生命周期 */
  private weakRefAvailable: boolean = typeof WeakRef !== 'undefined'
  /** 活跃句柄注册表，记录句柄的 WeakRef（若有）以便轮询释放 */
  private activeHandles: Map<string, { weakRef?: WeakRef<any> }> = new Map()
  /** WeakRef 轮询计时器句柄 */
  private sweeperTimer: any = null
  /** WeakRef sweeper 轮询间隔毫秒数（默认 60s，可配置） */
  private sweepIntervalMs: number
  /** pagehide 策略：非持久化/all/off，决定页面隐藏时的释放行为 */
  private releaseOnPageHide: 'nonPersisted' | 'all' | 'off'
  /** 是否物化结构；true 物化值树，false 使用懒代理 */
  private materializeStructure: boolean

  /**
   * 构造函数：配置客户端行为并初始化策略。
   * - gcSweepIntervalMs：WeakRef sweeper 的轮询间隔
   * - releaseOnPageHide：pagehide 时的释放策略（'nonPersisted' | 'all' | 'off'）
   * - hideStructure：为 true 使用懒代理（非物化），否则物化结构
   * - targetOrigin / allowedOrigins：消息发送目标与来源白名单
   */
  constructor(name: string, options?: CreateIframeRpcClientOptions) {
    this.name = name
    this.options = options
    this.sweepIntervalMs = typeof options?.gcSweepIntervalMs === 'number' ? Math.max(1, options.gcSweepIntervalMs!) : 60000
    this.releaseOnPageHide = options?.releaseOnPageHide ?? 'nonPersisted'
    this.materializeStructure = options?.hideStructure === true ? false : true
  }

  /**
   * 生成唯一的请求 ID，用于 RPC 消息关联。
   */
  

  /**
   * 计算 postMessage 的目标 origin。
   * 优先使用传入配置的 targetOrigin，其次服务端的实际来源，最后回退 '*'
   */
  private destinationOrigin() {
    if (this.options?.targetOrigin) return this.options.targetOrigin
    if (this.serverOrigin) return this.serverOrigin
    return '*'
  }

  /**
   * 校验消息来源是否符合 allowedOrigins 设置。
   * 支持数组或函数形式；未设置则允许所有来源。
   */
  private isOriginAllowed(origin: string) {
    const opt = this.options
    if (!opt?.allowedOrigins) return true
    if (typeof opt.allowedOrigins === 'function') {
      try { return opt.allowedOrigins(origin) } catch { return false }
    }
    const set = new Set(opt.allowedOrigins)
    return set.has(origin)
  }

  /**
   * 释放一个远程句柄：标记为已释放并通知服务端。
   */
  private releaseHandle(handleId: string) {
    this.released.add(handleId)
    this.activeHandles.delete(handleId)
    const tw = this.targetWindow
    if (!tw) return
    const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'RELEASE_HANDLE', handle: handleId }
    try { tw.postMessage(msg, this.destinationOrigin()) } catch {}
  }

  /**
   * 启动 WeakRef sweeper：当本地代理被 GC（deref 为 null）时，自动释放远端句柄。
   */
  private startWeakRefSweeper() {
    if (!this.weakRefAvailable || this.sweeperTimer) return
    this.sweeperTimer = setInterval(() => {
      for (const [id, meta] of this.activeHandles.entries()) {
        if (this.released.has(id)) { this.activeHandles.delete(id); continue }
        const ref = meta.weakRef
        if (!ref) continue
        if (ref.deref() == null) {
          this.releaseHandle(id)
          this.activeHandles.delete(id)
        }
      }
    }, this.sweepIntervalMs)
  }

  /**
   * 页面卸载前的清理：尝试释放所有仍活跃的句柄。
   */
  private onShutdown = () => {
    for (const id of this.activeHandles.keys()) {
      if (!this.released.has(id)) this.releaseHandle(id)
    }
    this.activeHandles.clear()
  }

  /**
   * pagehide 事件处理：根据策略在非持久化/全部情况下批量释放句柄。
   */
  private pagehideHandler = (ev: any) => {
    const persisted = !!(ev && ev.persisted)
    if (this.releaseOnPageHide === 'off') return
    if (this.releaseOnPageHide === 'all' || (this.releaseOnPageHide === 'nonPersisted' && !persisted)) {
      this.onShutdown()
    }
  }

  /**
   * 解析函数别名路径：
   * 在 canonicalIndex 中为对象找到规范路径后，判断函数集合中是否存在该路径对应的函数。
   */
  private resolveAliasFunctionPath(parentPath: string, key: string): string | null {
    const direct = parentPath ? `${parentPath}.${key}` : key
    if (this.functionSet.has(direct)) return direct
    const parentObj = getDeep(this.values, parentPath)
    if (!parentObj || typeof parentObj !== 'object') return null
    const canon = this.canonicalIndex.get(parentObj as object)
    if (!canon && canon !== '') return null
    const candidate = canon ? `${canon}.${key}` : key
    return this.functionSet.has(candidate) ? candidate : null
  }

  /**
   * 判断在某个前缀路径下是否存在函数定义（用于懒代理的可见性判断）。
   */
  private hasFunctionUnder(prefix: string) {
    const pre = prefix ? prefix + '.' : ''
    for (const f of this.functionSet) {
      if (f === prefix || f.startsWith(pre)) return true
    }
    return false
  }

  /**
   * 为根级函数路径创建可调用代理：
   * 调用时发送 CALL 消息，返回 Promise 并在 RESULT/ERROR 时解析。
   */
  private makeRootFunctionProxy(method: string) {
    return (...args: any[]) => {
      const tw = this.targetWindow
      if (!tw) return Promise.reject(new Error('RPC target not ready'))
    const id = genId()
      const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'CALL', id, method, args }
      try { console.log(`[rpc-client:${this.name}] CALL root method=${method} id=${id}`) } catch {}
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        tw.postMessage(msg, this.destinationOrigin())
      })
    }
  }

  /**
   * 读取根级值：
   * - 优先解析函数别名并返回可调用代理
   * - 对对象/数组：传递结构化克隆直传类型，否则返回懒代理子树
   * - 若该路径下存在函数，则返回懒代理子树
   */
  private readRootValue(prefix: string, key: string): any {
    const fullPath = prefix ? `${prefix}.${key}` : key
    const resolvedFnPath = this.resolveAliasFunctionPath(prefix, key)
    if (resolvedFnPath) return this.makeRootFunctionProxy(resolvedFnPath)
    const v = getDeep(this.values, fullPath)
    if (v !== undefined) {
      if (v !== null && typeof v === 'object') {
        if (isStructuredClonePassThrough(v)) return v
        return this.createLevelProxy(fullPath)
      }
      return v
    }
    if (this.hasFunctionUnder(fullPath)) return this.createLevelProxy(fullPath)
    const parentObj = getDeep(this.values, prefix)
    if (parentObj && typeof parentObj === 'object') {
      const canon = this.canonicalIndex.get(parentObj as object)
      const aliasPrefix = canon ? `${canon}.${key}` : key
      if (this.hasFunctionUnder(aliasPrefix)) return this.createLevelProxy(fullPath)
    }
    return undefined
  }

  /**
   * 创建懒代理节点：通过 get 拦截递归调用 readRootValue。
   */
  private createLevelProxy(prefix: string): any {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => this.readRootValue(prefix, String(prop)),
    }
    return new Proxy({}, handler)
  }

  /**
   * 物化根结构：深度克隆值树，并在函数叶子上挂载可调用代理。
   * 同时根据源结构决定目标节点是对象还是数组，以保持形状一致。
   */
  private createMaterializedRoot(): any {
    const srcRoot = this.values
    const mapSrcToDest = new WeakMap<object, any>()
    const cloneNode = (src: any): any => {
      if (!src || typeof src !== 'object') return src
      if (isStructuredClonePassThrough(src)) return src
      const hit = mapSrcToDest.get(src as object)
      if (hit) return hit
      let dest: any
      if (Array.isArray(src)) {
        dest = []
        mapSrcToDest.set(src as object, dest)
        for (let i = 0; i < src.length; i++) dest[i] = cloneNode(src[i])
      } else {
        dest = {}
        mapSrcToDest.set(src as object, dest)
        for (const k of Object.keys(src)) dest[k] = cloneNode(src[k])
      }
      return dest
    }
    const root = cloneNode(srcRoot)
    const ensureTargetForParentPath = (parentPath: string): any => {
      if (!parentPath) return root
      const srcParent = getDeep(this.values, parentPath)
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
        const nextSrc = getDeep(this.values, curPath)
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
    for (const method of this.functionSet) {
      const idx = method.lastIndexOf('.')
      const parentPath = idx >= 0 ? method.slice(0, idx) : ''
      const leafKey = idx >= 0 ? method.slice(idx + 1) : method
      const parentObj = ensureTargetForParentPath(parentPath)
      parentObj[leafKey] = this.makeRootFunctionProxy(method)
    }
    return root
  }

  /**
   * 为返回的对象句柄创建懒代理：
   * - 使用局部的函数集合与 canonical 索引解析别名
   * - 支持特殊方法 __release 用于主动释放句柄
   */
  private createScopedProxy(handleId: string, scopedValues: Record<string, any>, scopedFunctions: string[], prefix: string): any {
    const functionSetLocal = new Set<string>(scopedFunctions)
    const canonicalIndexLocal = buildCanonicalIndex(scopedValues)
    const target: Record<string, any> = {}
    const makeHandleFunctionProxy = (method: string) => {
      return (...args: any[]) => {
        if (this.released.has(handleId)) return Promise.reject(new Error(`Handle ${handleId} released`))
        const tw = this.targetWindow
        if (!tw) return Promise.reject(new Error('RPC target not ready'))
    const id = genId()
        const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'CALL', id, method, args, handle: handleId }
        try { console.log(`[rpc-client:${this.name}] CALL handle=${handleId} method=${method} id=${id}`) } catch {}
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject })
          tw.postMessage(msg, this.destinationOrigin())
        })
      }
    }
    const readScopedValue = (key: string): any => {
      const fullPath = prefix ? `${prefix}.${key}` : key
      if (key === '__release') return () => this.releaseHandle(handleId)
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
          return this.createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
        }
        return v
      }
      const pre = prefix ? prefix + '.' : ''
      if ([...functionSetLocal].some((f) => f === fullPath || f.startsWith(pre + key + '.'))) {
        return this.createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
      }
      const parentObj = getDeep(scopedValues, prefix)
      if (parentObj && typeof parentObj === 'object') {
        const canon = canonicalIndexLocal.get(parentObj as object)
        const aliasPrefix = canon ? `${canon}.${key}` : key
        const preAlias = aliasPrefix ? aliasPrefix + '.' : ''
        if ([...functionSetLocal].some((f) => f === aliasPrefix || f.startsWith(preAlias))) {
          return this.createScopedProxy(handleId, scopedValues, scopedFunctions, fullPath)
        }
      }
      return undefined
    }
    const handler: ProxyHandler<any> = { get: (_t, prop) => readScopedValue(String(prop)) }
    const proxy = new Proxy(target, handler)
    if (this.FinalReg) this.FinalReg.register(proxy, handleId)
    if (this.weakRefAvailable) this.activeHandles.set(handleId, { weakRef: new WeakRef(proxy) })
    this.startWeakRefSweeper()
    return proxy
  }

  /**
   * 为返回的对象句柄创建物化结构：
   * 深度克隆并注入可调用代理，附加 __release 以及 GC 监测。
   */
  private createMaterializedHandle(handleId: string, scopedValues: Record<string, any>, scopedFunctions: string[]): any {
    const functionSetLocal = new Set<string>(scopedFunctions)
    const mapSrcToDest = new WeakMap<object, any>()
    const cloneNode = (src: any): any => {
      if (!src || typeof src !== 'object') return src
      if (isStructuredClonePassThrough(src)) return src
      const hit = mapSrcToDest.get(src as object)
      if (hit) return hit
      let dest: any
      if (Array.isArray(src)) {
        dest = []
        mapSrcToDest.set(src as object, dest)
        for (let i = 0; i < src.length; i++) dest[i] = cloneNode(src[i])
      } else {
        dest = {}
        mapSrcToDest.set(src as object, dest)
        for (const k of Object.keys(src)) dest[k] = cloneNode(src[k])
      }
      return dest
    }
    const root = cloneNode(scopedValues)
    const ensureTargetForParentPathLocal = (parentPath: string): any => {
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
    const makeHandleFunctionProxy = (method: string) => {
      return (...args: any[]) => {
        if (this.released.has(handleId)) return Promise.reject(new Error(`Handle ${handleId} released`))
        const tw = this.targetWindow
        if (!tw) return Promise.reject(new Error('RPC target not ready'))
    const id = genId()
        const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'CALL', id, method, args, handle: handleId }
        try { console.log(`[rpc-client:${this.name}] CALL handle=${handleId} method=${method} id=${id}`) } catch {}
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject })
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
    ;(root as any).__release = () => this.releaseHandle(handleId)
    if (this.FinalReg) {
      try { this.FinalReg.register(root, handleId) } catch {}
    }
    if (this.weakRefAvailable) this.activeHandles.set(handleId, { weakRef: new WeakRef(root) })
    this.startWeakRefSweeper()
    return root
  }

  /**
   * 解析 RESULT 载荷：
   * - 对 handle：返回函数或对象代理（懒/物化取决于配置），附带释放与 GC 支持
   * - 对普通值：直接返回
   */
  private fromResultPayload(payload: any): any {
    if (!payload || typeof payload !== 'object') return payload
    if (payload.__rpc__ === 'handle') {
      const id = payload.id as string
      const kind = payload.kind as 'function' | 'object' | undefined
      const vals = payload.values || {}
      const funcs = payload.functions || []
      if (kind === 'function') {
        const fn: any = (...args: any[]) => {
          if (this.released.has(id)) return Promise.reject(new Error(`Handle ${id} released`))
          const tw = this.targetWindow
          if (!tw) return Promise.reject(new Error('RPC target not ready'))
    const callId = genId()
          const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'CALL', id: callId, method: '', args, handle: id }
          return new Promise((resolve, reject) => {
            this.pending.set(callId, { resolve, reject })
            tw.postMessage(msg, this.destinationOrigin())
          })
        }
        ;(fn as any).__release = () => this.releaseHandle(id)
        if (this.FinalReg) { try { this.FinalReg.register(fn, id) } catch {} }
        if (this.weakRefAvailable) this.activeHandles.set(id, { weakRef: new WeakRef(fn) })
        this.startWeakRefSweeper()
        return fn
      }
      if (this.materializeStructure) return this.createMaterializedHandle(id, vals, funcs)
      return this.createScopedProxy(id, vals, funcs, '')
    }
    return payload
  }

  /**
   * 初始化握手：监听 READY/RESULT/ERROR/INIT_ERROR，
   * 构建值与函数索引，并根据配置返回物化或懒代理根对象。
   */
  init(): Promise<Promisified<TApi>> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options?.timeout ?? 5000
      const handler = (event: MessageEvent) => {
        if (!this.isOriginAllowed(event.origin)) return
        const data: RpcMessage | any = event.data
        if (!data || data.rpc !== 'iframe-rpc' || data.name !== this.name) return
        if (data.type === 'READY') {
          clearTimeout(initTimer)
          this.targetWindow = event.source as Window | null
          this.serverOrigin = event.origin || null
          this.values = data.payload.values || {}
          this.canonicalIndex = buildCanonicalIndex(this.values)
          this.functionSet.clear()
          for (const fnName of data.payload.functions || []) this.functionSet.add(fnName)
          if (this.materializeStructure) {
            resolve(this.createMaterializedRoot() as Promisified<TApi>)
          } else {
            resolve(this.createLevelProxy('') as Promisified<TApi>)
          }
          return
        }
        if (data.type === 'RESULT') {
          const p = this.pending.get(data.id)
          if (p) {
            p.resolve(this.fromResultPayload(data.result))
            this.pending.delete(data.id)
          }
          return
        }
        if (data.type === 'ERROR') {
          try { console.log(`[rpc-client:${this.name}] ERROR id=${data.id} msg=${data.error} hasPending=${this.pending.has(data.id)}`) } catch {}
          const p = this.pending.get(data.id)
          if (p) {
            p.reject(new Error(data.error))
            this.pending.delete(data.id)
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
      const initTimer = setTimeout(() => {
        window.removeEventListener('message', handler)
        reject(new Error(`iframe-rpc initialization timeout for name: ${this.name}`))
      }, timeoutMs)
      try {
        window.addEventListener('beforeunload', this.onShutdown)
        window.addEventListener('pagehide', this.pagehideHandler)
        this.startWeakRefSweeper()
      } catch {}
    })
  }
}


/**
 * 工厂函数：保持对外 API 不变，内部封装为 IframeRpcClient 类并执行初始化。
 */
export function createIframeRpcClient<TApi extends Record<string, any>>(name: string, options?: CreateIframeRpcClientOptions): Promise<Promisified<TApi>> {
  const client = new IframeRpcClient<TApi>(name, options)
  return client.init()
}
