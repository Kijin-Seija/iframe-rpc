import { describe, it, expect } from 'vitest'
import { createIframeRpcServer } from '../packages/iframe-rpc-server/src/index'
import { createIframeRpcClient } from '../packages/iframe-rpc-client/src/index'
import type { TestApi } from '../src/types'

class FakeWindow {
  listeners: ((e: MessageEvent) => void)[] = []
  counterpart: FakeWindow | null = null
  parent: FakeWindow = this

  constructor(public name: string) {}

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(handler)
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (type === 'message') {
      this.listeners = this.listeners.filter((h) => h !== handler)
    }
  }

  postMessage(data: any, _targetOrigin: string) {
    const source = this.counterpart ?? this
    const event = { data, source } as unknown as MessageEvent
    this.listeners.forEach((h) => h(event))
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
})
