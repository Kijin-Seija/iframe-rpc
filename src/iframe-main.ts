import { createIframeRpcServer } from '../packages/iframe-rpc-server/src/index'
import type { TestApi } from './types'

const api: TestApi = {
  a: 1,
  test: (param: number) => {
    console.log('hi, im test api')
    return param + 1
  },
  nested: {
    a: 2,
    test: (param: number) => {
      console.log('hi, im nested test api')
      return param + 10
    },
    nested: {
      a: 3,
      test: (param: number) => {
        console.log('hi, im nested nested test api')
        return param + 100
      },
    }
  },
  testNested: (param: number) => {
    console.log('hi, im test nested api')
    return {
      a: param + 10000,
      test: (param: number) => {
        console.log('hi, im test nested test api')
        return param + 10000
      },
    }
  },
  mkAdder: (x: number) => {
    console.log('hi, im mkAdder')
    return (y: number) => {
      console.log('hi, im returned adder')
      return x + y
    }
  },
  makeObj: (seed: number) => {
    console.log('hi, im makeObj')
    return {
      val: seed,
      nested: {
        val: seed + 1,
        fn: (n: number) => {
          console.log('hi, im nested.fn')
          return n + seed
        },
        deeper: {
          val: seed + 2,
          fn2: (n: number) => {
            console.log('hi, im nested.deeper.fn2')
            return n + seed * 2
          },
        },
      },
      fn: (n: number) => {
        console.log('hi, im makeObj.fn')
        return {
          val: n + seed,
          deepFn: (m: number) => {
            console.log('hi, im makeObj.fn.deepFn')
            return m + n + seed
          },
        }
      },
    }
  },
  testPromise: (param: number) => {
    console.log('hi, im testPromise api')
    return Promise.resolve(param + 1)
  },
  testNestedPromise: (param: number) => {
    console.log('hi, im testNestedPromise api')
    return Promise.resolve({
      val: param + 10000,
      test: (param: number) => {
        console.log('hi, im testNestedPromise test api')
        return Promise.resolve(param + 10000)
      },
    })
  },
}

createIframeRpcServer(api, { name: 'testApi' })

document.body.innerHTML = `<div style="padding:12px;font-family:sans-serif">iframe 服务已启动（name: testApi）</div>`
