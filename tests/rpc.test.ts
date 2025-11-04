import { describe, it, expect } from 'vitest'
import { createIframeRpcServer } from '../packages/iframe-rpc-server/src/index'
import { createIframeRpcClient } from '../packages/iframe-rpc-client/src/index'
import type { TestApi } from '../src/types'

class FakeWindow {
  listeners: ((e: MessageEvent) => void)[] = []
  otherListeners: Record<string, ((e: any) => void)[]> = {}
  counterpart: FakeWindow | null = null
  parent: FakeWindow = this

  constructor(public name: string) {}

  addEventListener(type: string, handler: (e: any) => void) {
    if (type === 'message') this.listeners.push(handler as any)
    else {
      const arr = this.otherListeners[type] || []
      arr.push(handler)
      this.otherListeners[type] = arr
    }
  }

  removeEventListener(type: string, handler: (e: any) => void) {
    if (type === 'message') {
      this.listeners = this.listeners.filter((h) => h !== handler)
    } else {
      const arr = this.otherListeners[type] || []
      this.otherListeners[type] = arr.filter((h) => h !== handler)
    }
  }

  postMessage(data: any, _targetOrigin: string) {
    const source = this.counterpart ?? this
    const event = { data, source } as unknown as MessageEvent
    this.listeners.forEach((h) => h(event))
  }

  dispatch(type: string, evt?: any) {
    const handlers = this.otherListeners[type] || []
    const e = Object.assign({ type }, evt || {}) as any
    handlers.forEach((h) => h(e))
  }
}

function createPair() {
  const parent = new FakeWindow('parent')
  const child = new FakeWindow('child')
  parent.counterpart = child
  child.counterpart = parent
  child.parent = parent
  parent.parent = parent
  return { parent, child }
}

describe('iframe-rpc 集成测试', () => {
  it('复刻值并将函数 Promise 化', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      // start client first (parent), then server (child) so READY is received
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('testApi')

      ;(globalThis as any).window = child as any
      const api = { a: 1, test: (n: number) => n + 1 }
      createIframeRpcServer(api as any, { name: 'testApi' })

      ;(globalThis as any).window = parent as any
      const myApi = await clientPromise
      expect(myApi.a).toBe(1)
      const r = await myApi.test(1)
      expect(r).toBe(2)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('服务端 getter 的当前值会在 READY 快照中传递（对象字面量）', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ title: string }>('getter-literal')

      ;(globalThis as any).window = child as any
      const api = {
        get title() { return 'Hello Getter' },
      }
      createIframeRpcServer(api as any, { name: 'getter-literal' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.title).toBe('Hello Getter')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('服务端原型链上的 getter 也能传递（类实例）', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    class Doc {
      get title() { return 'Proto Getter' }
    }
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ title: string }>('getter-proto')

      ;(globalThis as any).window = child as any
      const api = new Doc()
      createIframeRpcServer(api as any, { name: 'getter-proto' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.title).toBe('Proto Getter')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('非枚举的 getter 也会被读取并传递值', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ secret: number }>('getter-nonenumerable')

      ;(globalThis as any).window = child as any
      const api: any = {}
      Object.defineProperty(api, 'secret', {
        get() { return 42 },
        enumerable: false,
      })
      createIframeRpcServer(api as any, { name: 'getter-nonenumerable' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.secret).toBe(42)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('getter 抛错时跳过该属性，不在客户端暴露', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ ok: number }>('getter-throws')

      ;(globalThis as any).window = child as any
      const api: any = { ok: 1 }
      Object.defineProperty(api, 'unstable', {
        get() { throw new Error('not-ready') },
        enumerable: true,
      })
      createIframeRpcServer(api as any, { name: 'getter-throws' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.ok).toBe(1)
      expect((client as any).unstable).toBeUndefined()
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('错误通过拒绝的 Promise 传播', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ fail: () => number }>('errApi')

      ;(globalThis as any).window = child as any
      const api = { fail: async () => { throw new Error('boom') } }
      createIframeRpcServer(api, { name: 'errApi' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      await expect(client.fail()).rejects.toThrow('boom')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持并发调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ add: (a: number, b: number) => number }>('parallel')

      ;(globalThis as any).window = child as any
      const api = { add: (a: number, b: number) => a + b }
      createIframeRpcServer(api, { name: 'parallel' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const [r1, r2, r3] = await Promise.all([
        client.add(1, 2),
        client.add(3, 4),
        client.add(10, 5),
      ])
      expect(r1).toBe(3)
      expect(r2).toBe(7)
      expect(r3).toBe(15)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持嵌套对象：读取值与调用函数', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('nested')

      ;(globalThis as any).window = child as any
      const api = {
        a: 0,
        test: (n: number) => n,
        nested: {
          a: 2,
          test: (n: number) => n + 10,
        },
      }
      createIframeRpcServer(api as any, { name: 'nested' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.nested.a).toBe(2)
      const r = await client.nested.test(1)
      expect(r).toBe(11)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('初始化失败时客户端收到错误（INIT_ERROR）', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    const origPostMessage = parent.postMessage.bind(parent)
    try {
      // 客户端在父窗口
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ x: number }>('bad', { timeout: 1000 })

      // 在服务端发送 READY 时模拟结构化克隆失败，仅对 READY 抛错
      parent.postMessage = ((data: any, targetOrigin: string) => {
        if (data && data.type === 'READY') {
          throw new Error('DataCloneError: Uncloneable payload')
        }
        return origPostMessage(data, targetOrigin)
      }) as any

      // 服务端在子窗口
      ;(globalThis as any).window = child as any
      const api = { x: 1 }
      createIframeRpcServer(api as any, { name: 'bad' })

      // 回到父窗口，客户端应因 INIT_ERROR 失败
      ;(globalThis as any).window = parent as any
      await expect(clientPromise).rejects.toThrow('Uncloneable payload')
    } finally {
      parent.postMessage = origPostMessage as any
      ;(globalThis as any).window = original
    }
  })

  it('初始化超时会拒绝 Promise', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    const origPostMessage = parent.postMessage.bind(parent)
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ y: number }>('timeout', { timeout: 50 })

      // 模拟 READY 与 INIT_ERROR 都无法送达（postMessage 总是抛错）
      parent.postMessage = ((data: any, _targetOrigin: string) => {
        throw new Error('postMessage blocked')
      }) as any

      ;(globalThis as any).window = child as any
      const api = { y: 1 }
      createIframeRpcServer(api as any, { name: 'timeout' })

      ;(globalThis as any).window = parent as any
      await expect(clientPromise).rejects.toThrow('initialization timeout')
    } finally {
      parent.postMessage = origPostMessage as any
      ;(globalThis as any).window = original
    }
  })

  it('函数返回对象且对象内含函数可以调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('nested-return')

      ;(globalThis as any).window = child as any
      const api = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => {
          return {
            a: param + 1000,
            test: (n: number) => n + 1000,
          }
        },
      }
      createIframeRpcServer(api as any, { name: 'nested-return' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(1)
      expect(obj.a).toBe(1001)
      const r = await obj.test(1)
      expect(r).toBe(1001)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持函数返回 Promise<number>', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ testPromise: (n: number) => Promise<number> }>('promise-prim')

      ;(globalThis as any).window = child as any
      const api = { testPromise: (n: number) => Promise.resolve(n + 1) }
      createIframeRpcServer(api as any, { name: 'promise-prim' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const r = await client.testPromise(1)
      expect(r).toBe(2)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持函数返回 Promise<对象含函数> 并可继续调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkObjAsync: (seed: number) => Promise<{ a: number; test: (n: number) => number }> }>('promise-obj')

      ;(globalThis as any).window = child as any
      const api = {
        mkObjAsync: async (seed: number) => ({ a: seed + 100, test: (n: number) => n + seed })
      }
      createIframeRpcServer(api as any, { name: 'promise-obj' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.mkObjAsync(5)
      expect(obj.a).toBe(105)
      const r = await obj.test(2)
      expect(r).toBe(7)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持函数返回 Promise<函数> 并可继续调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkAdderAsync: (x: number) => Promise<(y: number) => number> }>('promise-fn')

      ;(globalThis as any).window = child as any
      const api = {
        mkAdderAsync: async (x: number) => (y: number) => x + y
      }
      createIframeRpcServer(api as any, { name: 'promise-fn' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const add2 = await client.mkAdderAsync(2)
      const r = await add2(3)
      expect(r).toBe(5)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('按值直传：根值中的内置对象（Date/RegExp/Map/Set/TypedArray）', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{
        d: Date
        r: RegExp
        m: Map<string, number>
        s: Set<number>
        ta: Uint8Array
      }>('builtins-root')

      ;(globalThis as any).window = child as any
      const api = {
        d: new Date('2020-01-01T00:00:00Z'),
        r: /abc/i,
        m: new Map<string, number>([['x', 42]]),
        s: new Set<number>([1, 2, 3]),
        ta: new Uint8Array([1, 2, 3]),
      }
      createIframeRpcServer(api as any, { name: 'builtins-root' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.d instanceof Date).toBe(true)
      expect(client.d.getUTCFullYear()).toBe(2020)
      expect(client.r.test('ABC')).toBe(true)
      expect(client.m instanceof Map).toBe(true)
      expect(client.m.get('x')).toBe(42)
      expect(client.s instanceof Set).toBe(true)
      expect(client.s.has(2)).toBe(true)
      expect(client.ta instanceof Uint8Array).toBe(true)
      expect(client.ta[0]).toBe(1)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('按值直传：返回对象中的内置对象（Date/Map/Set/TypedArray）保留原生行为', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{
        mkMixed: (seed: number) => {
          val: number
          date: Date
          reg: RegExp
          map: Map<string, number>
          set: Set<number>
          ta: Uint8Array
          test: (n: number) => number
        }
      }>('builtins-nested')

      ;(globalThis as any).window = child as any
      const api = {
        mkMixed: (seed: number) => ({
          val: seed,
          date: new Date('2022-02-02T02:02:02Z'),
          reg: /def/i,
          map: new Map<string, number>([['y', seed * 10]]),
          set: new Set<number>([seed, seed + 1]),
          ta: new Uint8Array([seed, seed + 1]),
          test: (n: number) => n + seed,
        }),
      }
      createIframeRpcServer(api as any, { name: 'builtins-nested' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.mkMixed(5)
      expect(obj.val).toBe(5)
      expect(obj.date instanceof Date).toBe(true)
      expect(obj.date.getUTCFullYear()).toBe(2022)
      expect(obj.reg.test('DEF')).toBe(true)
      expect(obj.map instanceof Map).toBe(true)
      expect(obj.map.get('y')).toBe(50)
      expect(obj.set instanceof Set).toBe(true)
      expect(obj.set.has(6)).toBe(true)
      expect(obj.ta instanceof Uint8Array).toBe(true)
      expect(obj.ta[0]).toBe(5)
      const r = await obj.test(2)
      expect(r).toBe(7)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('函数返回函数可以继续调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkAdder: (x: number) => (y: number) => number }>('fnfn')

      ;(globalThis as any).window = child as any
      const api = {
        mkAdder: (x: number) => {
          return (y: number) => x + y
        },
      }
      createIframeRpcServer(api as any, { name: 'fnfn' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const add2 = await client.mkAdder(2)
      const r = await add2(3)
      expect(r).toBe(5)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('释放对象句柄后再次调用报错', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('release-obj')

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'release-obj' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)
      // release
      ;(obj as any).__release()
      // after release, further calls should error
      await expect(obj.test(1)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('释放函数句柄后再次调用报错', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkAdder: (x: number) => (y: number) => number }>('release-fn')

      ;(globalThis as any).window = child as any
      const api = { mkAdder: (x: number) => (y: number) => x + y }
      createIframeRpcServer(api as any, { name: 'release-fn' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const add2 = await client.mkAdder(2)
      const r = await add2(3)
      expect(r).toBe(5)
      ;(add2 as any).__release()
      await expect(add2(3)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('WeakRef 轮询释放在 deref 为 undefined 时触发释放', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    const originalWeakRef = (globalThis as any).WeakRef
    class MockWeakRef<T> {
      static forceNull = false
      private obj: T | null
      constructor(obj: T) { this.obj = obj }
      deref() { return (MockWeakRef.forceNull ? undefined : this.obj) as any }
    }
    try {
      ;(globalThis as any).WeakRef = MockWeakRef as any
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('weakref-release', { gcSweepIntervalMs: 10 })

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'weakref-release' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)

      // 模拟 GC：让 WeakRef.deref() 返回 undefined
      MockWeakRef.forceNull = true
      await new Promise((res) => setTimeout(res, 20))
      await expect(obj.test(1)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).WeakRef = originalWeakRef
      ;(globalThis as any).window = original
    }
  })

  it('pagehide 触发批量释放后再次调用报错', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('pagehide-release')

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'pagehide-release' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)
      // 触发 pagehide 事件，客户端应批量释放所有活跃句柄
      parent.dispatch('pagehide', { persisted: false })
      await expect(obj.test(1)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('pagehide persisted:true 默认 nonPersisted 不释放', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('pagehide-nonpersisted-default')

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'pagehide-nonpersisted-default' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)
      // 模拟 BFCache：persisted=true 时默认不释放
      parent.dispatch('pagehide', { persisted: true })
      const r2 = await obj.test(1)
      expect(r2).toBe(6)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('pagehide persisted:true 在策略 all 下会释放', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('pagehide-all', { releaseOnPageHide: 'all' })

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'pagehide-all' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)
      // 在 all 策略下，persisted=true 也释放
      parent.dispatch('pagehide', { persisted: true })
      await expect(obj.test(1)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('pagehide persisted:false 在策略 off 下不释放', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('pagehide-off', { releaseOnPageHide: 'off' })

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'pagehide-off' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)
      // 在 off 策略下，persisted=false 也不释放
      parent.dispatch('pagehide', { persisted: false })
      const r2 = await obj.test(1)
      expect(r2).toBe(6)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('服务端闲置 TTL 清理后句柄过期调用报错', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('rpc-ttl')

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'rpc-ttl', handleTtlMs: 20, sweepIntervalMs: 5 })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)

      // 等待超过 TTL，让服务端清理闲置句柄
      await new Promise((r) => setTimeout(r, 50))

      // 过期后再次调用应报错（服务端返回 Handle not found）
      await expect(obj.test(1)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持根级数组内的函数调用与嵌套', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ arr: any[] }>('array-root')

      ;(globalThis as any).window = child as any
      const api = {
        arr: [
          (n: number) => n + 1,
          (n: number) => n + 10,
          { inner: (n: number) => n + 100 },
        ],
      }
      createIframeRpcServer(api as any, { name: 'array-root' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const r0 = await (client.arr as any)[0](1)
      expect(r0).toBe(2)
      const r1 = await (client.arr as any)[1](1)
      expect(r1).toBe(11)
      const r2 = await (client.arr as any)[2].inner(1)
      expect(r2).toBe(101)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持返回值为数组且数组内含函数的继续调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkArr: (seed: number) => any[] }>('array-return')

      ;(globalThis as any).window = child as any
      const api = {
        mkArr: async (seed: number) => [
          (n: number) => n + seed,
          { inner: (n: number) => n + seed * 10 },
        ],
      }
      createIframeRpcServer(api as any, { name: 'array-return' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const arr = await client.mkArr(2)
      const r0 = await arr[0](3)
      expect(r0).toBe(5)
      const r1 = await arr[1].inner(1)
      expect(r1).toBe(21)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持 API 中循环引用（值与函数）', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ cycle: any }>('cycle-root')

      ;(globalThis as any).window = child as any
      const cycle: any = { a: 1, nested: { val: 2 } }
      cycle.self = cycle
      cycle.nested.parent = cycle
      cycle.nested.fn = (n: number) => n + cycle.a
      const api = { cycle }
      createIframeRpcServer(api as any, { name: 'cycle-root' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      expect(client.cycle.a).toBe(1)
      expect(client.cycle.self.a).toBe(1)
      expect(client.cycle.nested.parent.a).toBe(1)
      const r = await client.cycle.nested.fn(2)
      expect(r).toBe(3)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('支持函数返回对象包含循环引用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkCyclic: (seed: number) => any }>('cycle-return')

      ;(globalThis as any).window = child as any
      const api = {
        mkCyclic: (seed: number) => {
          const o: any = { a: seed }
          o.self = o
          o.nested = { val: seed + 1 }
          o.nested.parent = o
          o.nested.fn = (n: number) => n + o.a
          return o
        },
      }
      createIframeRpcServer(api as any, { name: 'cycle-return' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.mkCyclic(10)
      expect(obj.a).toBe(10)
      expect(obj.self.a).toBe(10)
      expect(obj.nested.parent.a).toBe(10)
      const r = await obj.nested.fn(5)
      expect(r).toBe(15)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('非物化模式：返回对象懒代理不可枚举但可调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('materialize-object', { hideStructure: true })

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param + 1000, test: (n: number) => n + 1000 }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'materialize-object' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(1)
      const keys = Object.keys(obj)
      expect(keys.includes('a')).toBe(false)
      expect(keys.includes('test')).toBe(false)
      expect(typeof obj.test).toBe('function')
      const r = await obj.test(1)
      expect(r).toBe(1001)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('非物化模式：返回数组可索引调用但不可枚举', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkArr: (seed: number) => any[] }>('materialize-array', { hideStructure: true })

      ;(globalThis as any).window = child as any
      const api = {
        mkArr: async (seed: number) => [
          (n: number) => n + seed,
          { inner: (n: number) => n + seed * 10 },
        ],
      }
      createIframeRpcServer(api as any, { name: 'materialize-array' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const arr = await client.mkArr(2)
      const r0 = await arr[0](3)
      expect(r0).toBe(5)
      const r1 = await arr[1].inner(1)
      expect(r1).toBe(21)
      const k = Object.keys(arr)
      expect(k.includes('0')).toBe(false)
      expect(k.includes('1')).toBe(false)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('非物化模式：循环别名路径下函数可见并可调用', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ mkCyclic: (seed: number) => any }>('materialize-cycle', { hideStructure: true })

      ;(globalThis as any).window = child as any
      const api = {
        mkCyclic: (seed: number) => {
          const o: any = { a: seed }
          o.self = o
          o.nested = { val: seed + 1 }
          o.nested.parent = o
          o.nested.fn = (n: number) => n + o.a
          return o
        },
      }
      createIframeRpcServer(api as any, { name: 'materialize-cycle' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.mkCyclic(10)
      expect(typeof obj.self.nested.fn).toBe('function')
      const r = await obj.self.nested.fn(5)
      expect(r).toBe(15)
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('非物化模式：返回对象支持 __release 并释放后调用报错', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<TestApi>('materialize-release', { hideStructure: true })

      ;(globalThis as any).window = child as any
      const api: TestApi = {
        a: 1,
        test: (n: number) => n + 1,
        nested: { a: 2, test: (n: number) => n + 10, nested: { a: 3, test: (n: number) => n + 100 } },
        testNested: (param: number) => ({ a: param, test: (n: number) => n + param }),
        mkAdder: (x: number) => (y: number) => x + y,
        makeObj: (seed: number) => ({ val: seed, nested: { val: seed + 1, fn: (n: number) => n + seed, deeper: { val: seed + 2, fn2: (n: number) => n + seed * 2 } }, fn: (n: number) => ({ val: n + seed, deepFn: (m: number) => m + n + seed }) }),
      }
      createIframeRpcServer(api as any, { name: 'materialize-release' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      const obj = await client.testNested(5)
      const r1 = await obj.test(1)
      expect(r1).toBe(6)
      ;(obj as any).__release()
      await expect(obj.test(1)).rejects.toThrow('Handle')
    } finally {
      ;(globalThis as any).window = original
    }
  })

  it('物化模式：类实例原型方法与字段方法均可调用且保持 this', async () => {
    const { parent, child } = createPair()
    const original = globalThis.window
    try {
      ;(globalThis as any).window = parent as any
      const clientPromise = createIframeRpcClient<{ a: any }>('class-methods')

      ;(globalThis as any).window = child as any
      class A {
        n = 3
        foo() { return this.n + 1 }
        bar = () => this.n + 2
      }
      const api = { a: new A() }
      createIframeRpcServer(api as any, { name: 'class-methods' })

      ;(globalThis as any).window = parent as any
      const client = await clientPromise
      // 原型方法
      const rFoo = await client.a.foo()
      expect(rFoo).toBe(4)
      // 字段方法（箭头函数）
      const rBar = await client.a.bar()
      expect(rBar).toBe(5)
    } finally {
      ;(globalThis as any).window = original
    }
  })
})
