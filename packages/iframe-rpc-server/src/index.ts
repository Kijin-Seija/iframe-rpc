import type { CreateIframeRpcServerOptions, RpcMessage } from '../../../shared/types.ts'
export type { CreateIframeRpcServerOptions } from '../../../shared/types.ts'
import { isObject, collectFunctionPaths, cloneValuesOnly, serializeError, getDeep, genId } from '../../../shared/utils.ts'

/**
 * Iframe RPC 服务端：驻留于 iframe 页面中，暴露传入的 API，
 * 负责值快照与函数路径收集、处理客户端调用并按需返回句柄。
 *
 * 设计要点：
 * - 通过 `collectFunctionPaths` 收集 API 中所有可调用函数的路径，便于客户端生成代理。
 * - 对返回值进行序列化：无函数直接返回，有函数则生成可释放的句柄（handle）。
 * - 维护句柄 TTL 与周期清扫，避免长时间占用内存与资源。
 * - 通过 `allowedOrigins` 与 `targetOrigin` 控制消息来源与发送目标，确保安全。
 *
 * TApi 为暴露给客户端的远程 API 形状。
 */
export class IframeRpcServer<TApi extends Record<string, any>> {
  /** 通道名称：用于消息识别与匹配 */
  private name: string
  /** 远程 API 实例：对外暴露的方法与数据 */
  private api: TApi
  /** 句柄表：记录返回的函数/对象句柄 id -> 实际值 */
  private handles: Map<string, any> = new Map()
  /** 句柄元数据：currently 仅记录 lastUsed 时间戳，用于 TTL 清理 */
  private handleMeta: Map<string, { lastUsed: number }> = new Map()
  /** 句柄生存时间（毫秒）：超过该时间未使用的句柄将被清理 */
  private ttlMs: number
  /** 清扫间隔（毫秒）：定时扫描句柄并按 TTL 驱逐 */
  private sweepMs: number
  /** 发送目标 origin：postMessage 时使用，默认 '*' */
  private targetOrigin: string
  /** 来源校验函数：根据配置生成，决定是否处理消息 */
  private isOriginAllowed: (origin: string) => boolean
  /** API 的值快照：剔除函数，仅保留可结构化克隆的值 */
  private values: Record<string, any>
  /** API 的函数路径列表：用于客户端生成代理与可见性判断 */
  private functions: string[]

  /**
   * 构造函数：初始化服务端实例与各项策略。
   * - name：RPC 通道名称。
   * - handleTtlMs：句柄 TTL 毫秒数（默认 10 分钟）。
   * - sweepIntervalMs：句柄清扫间隔（默认 60 秒）。
   * - allowedOrigins：允许的消息来源（字符串列表或校验函数）。
   * - targetOrigin：postMessage 目标 origin（默认 '*'）。
   */
  constructor(api: TApi, options: CreateIframeRpcServerOptions) {
    this.api = api
    this.name = options.name
    const DEFAULT_TTL = 10 * 60 * 1000
    const DEFAULT_SWEEP = 60 * 1000
    this.ttlMs = Math.max(0, options.handleTtlMs ?? DEFAULT_TTL)
    this.sweepMs = Math.max(0, options.sweepIntervalMs ?? DEFAULT_SWEEP)
    this.targetOrigin = options.targetOrigin ?? '*'
    if (!options.allowedOrigins) {
      this.isOriginAllowed = (_: string) => true
    } else if (typeof options.allowedOrigins === 'function') {
      this.isOriginAllowed = options.allowedOrigins
    } else {
      const set = new Set(options.allowedOrigins)
      this.isOriginAllowed = (origin: string) => set.has(origin)
    }

    this.values = cloneValuesOnly(api)
    this.functions = collectFunctionPaths(api)

    try {
      if (window.parent && window.parent !== window) {
        this.sendReady(window.parent, this.targetOrigin)
      }
    } catch (err) {
      try {
        if (window.parent && window.parent !== window) {
          const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'INIT_ERROR', error: serializeError(err) }
          window.parent.postMessage(msg, this.targetOrigin)
        }
      } catch {}
    }

    window.addEventListener('message', this.onMessage)
    if (this.ttlMs > 0 && this.sweepMs > 0) this.startSweeper()
  }

  

  /**
   * 发送 READY 消息给客户端，携带值快照与函数路径，完成握手。
   */
  private sendReady(to: Window, toOrigin?: string) {
    const msg: RpcMessage = {
      rpc: 'iframe-rpc',
      name: this.name,
      type: 'READY',
      payload: { values: this.values, functions: this.functions },
    }
    to.postMessage(msg, toOrigin ?? this.targetOrigin)
  }

  /**
   * 序列化函数调用结果：
   * - 若无函数，则直接返回原值；
   * - 若包含函数或本身为函数，则注册句柄并返回句柄载荷，供客户端后续调用。
   */
  private serializeResult(result: any): any {
    const hasFunctions = typeof result === 'function' || (isObject(result) && collectFunctionPaths(result).length > 0)
    if (!hasFunctions) return result
      const id = genId()
    this.handles.set(id, result)
    this.handleMeta.set(id, { lastUsed: Date.now() })
    if (typeof result === 'function') return { __rpc__: 'handle', id, kind: 'function' }
    return { __rpc__: 'handle', id, kind: 'object', values: cloneValuesOnly(result), functions: collectFunctionPaths(result) }
  }

  /**
   * 消息处理入口：
   * - 过滤不允许来源的消息；
   * - 处理 GET：向请求源回发 READY；
   * - 处理 CALL：定位方法并执行，返回 RESULT 或 ERROR；
   * - 处理 RELEASE_HANDLE：移除对应句柄与元数据。
   */
  private onMessage = async (event: MessageEvent) => {
    if (!this.isOriginAllowed(event.origin)) {
      try { console.warn(`[rpc-server:${this.name}] blocked message from disallowed origin: ${event.origin}`) } catch {}
      return
    }
    const data: RpcMessage | any = event.data
    if (!data || data.rpc !== 'iframe-rpc' || data.name !== this.name) return
    const source = event.source as Window | null
    if (!source) return

    if (data.type === 'GET') {
      this.sendReady(source, event.origin)
      return
    }

    if (data.type === 'CALL') {
      const { id, method, args, handle } = data
      const ctx = handle ? this.handles.get(handle) : this.api
      if (handle && !ctx) {
        try { console.log(`[rpc-server:${this.name}] call on missing handle ${handle}`) } catch {}
        const errMsg = `Handle ${handle} not found`
        const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'ERROR', id, error: errMsg }
        source.postMessage(msg, event.origin)
        return
      }
      if (handle) {
        const meta = this.handleMeta.get(handle)
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
        const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'ERROR', id, error: errMsg }
        source.postMessage(msg, event.origin)
        return
      }
      try {
        const result = await Promise.resolve(fn.apply(callThis, args))
        const serialized = this.serializeResult(result)
        const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'RESULT', id, result: serialized }
        source.postMessage(msg, event.origin)
      } catch (err) {
        const msg: RpcMessage = { rpc: 'iframe-rpc', name: this.name, type: 'ERROR', id, error: serializeError(err) }
        source.postMessage(msg, event.origin)
      }
      return
    }

    if (data.type === 'RELEASE_HANDLE') {
      const id = data.handle
      if (id) {
        this.handles.delete(id)
        this.handleMeta.delete(id)
      }
      return
    }
  }

  /**
   * 启动句柄 TTL 清扫器：定时扫描并驱逐长时间未使用的句柄。
   */
  private startSweeper() {
    setInterval(() => {
      const now = Date.now()
      for (const [id, meta] of this.handleMeta.entries()) {
        if (now - meta.lastUsed > this.ttlMs) {
          try { console.log(`[rpc-server:${this.name}] evict handle ${id} due to ttl ${this.ttlMs}ms`) } catch {}
          this.handleMeta.delete(id)
          this.handles.delete(id)
        }
      }
    }, this.sweepMs)
  }
}

/** 保持原 API：工厂函数侧效构建服务端并就绪，不返回实例 */
export function createIframeRpcServer<TApi extends Record<string, any>>(api: TApi, options: CreateIframeRpcServerOptions) {
  new IframeRpcServer<TApi>(api, options)
}
