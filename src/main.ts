import { createIframeRpcClient } from '../packages/iframe-rpc-client/src/index'
import type { TestApi } from './types'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <div>
    <h1>iframe-rpc 调试页（外层）</h1>
    <iframe id="demo-iframe" src="/iframe.html" style="width:100%;height:160px;border:1px solid #ccc"></iframe>
    <div id="log" style="margin-top:12px"></div>
  </div>
`

const logEl = document.getElementById('log')!
function log(msg: string) {
  const p = document.createElement('div')
  p.textContent = msg
  logEl.appendChild(p)
}

;(async () => {
  const myApi = await createIframeRpcClient<TestApi>('testApi')
  log('client ready')
  log('myApi.a = ' + myApi.a)
  const r = await myApi.test(1)
  log('myApi.test(1) -> ' + r)
  // nested demo
  log('myApi.nested.a = ' + myApi.nested.a)
  const r2 = await myApi.nested.test(1)
  log('myApi.nested.test(1) -> ' + r2)
  // nested nested demo
  log('myApi.nested.nested.a = ' + myApi.nested.nested.a)
  const r3 = await myApi.nested.nested.test(1)
  log('myApi.nested.nested.test(1) -> ' + r3)
  // testNested demo
  log('myApi.testNested(1).a = ' + (await myApi.testNested(1)).a)
  const r4 = await (await myApi.testNested(1)).test(1)
  log('myApi.testNested(1).test(1) -> ' + r4)

  // mkAdder demo（函数嵌套函数）
  const add2 = await myApi.mkAdder(2)
  const add2r = await add2(3)
  log('await (await myApi.mkAdder(2))(3) -> ' + add2r)

  // makeObj demo（函数嵌套对象 + 对象嵌套对象/函数，多层组合）
  const obj = await myApi.makeObj(10)
  log('await myApi.makeObj(10).val -> ' + obj.val)
  log('await myApi.makeObj(10).nested.val -> ' + obj.nested.val)
  const makeObjFnR = await obj.nested.fn(5)
  log('await (await myApi.makeObj(10)).nested.fn(5) -> ' + makeObjFnR)
  log('await myApi.makeObj(10).nested.deeper.val -> ' + obj.nested.deeper.val)
  const deeperFnR = await obj.nested.deeper.fn2(7)
  log('await (await myApi.makeObj(10)).nested.deeper.fn2(7) -> ' + deeperFnR)
  const objFn = await obj.fn(3)
  log('await (await myApi.makeObj(10)).fn(3).val -> ' + objFn.val)
  const deepFnR = await objFn.deepFn(4)
  log('await (await (await myApi.makeObj(10)).fn(3)).deepFn(4) -> ' + deepFnR)
  // testPromise demo
  const promiseR = await myApi.testPromise(1000)
  log('await myApi.testPromise(1000) -> ' + promiseR)
  // testNestedPromise demo
  const nestedPromiseR = await myApi.testNestedPromise(10000)
  log('await myApi.testNestedPromise(10000).val -> ' + nestedPromiseR.val)
  const nestedPromiseTestR = await nestedPromiseR.test(20000)
  log('await (await myApi.testNestedPromise(10000)).test(20000) -> ' + nestedPromiseTestR)

  // Builtins (根值) 演示
  log('myApi.dateNow instanceof Date -> ' + (myApi.dateNow instanceof Date))
  log('myApi.dateNow.getUTCFullYear() -> ' + myApi.dateNow.getUTCFullYear())
  log('myApi.reg.test("HELLO") -> ' + myApi.reg.test('HELLO'))
  log('myApi.mapVal.get("a") -> ' + myApi.mapVal.get('a'))
  log('myApi.setVal.has(2) -> ' + myApi.setVal.has(2))
  log('myApi.taVal[0] -> ' + myApi.taVal[0])

  // Builtins（返回对象中）演示
  const mixed = await myApi.mkMixed(5)
  log('await myApi.mkMixed(5).val -> ' + mixed.val)
  log('await myApi.mkMixed(5).date.getUTCFullYear() -> ' + mixed.date.getUTCFullYear())
  log('await myApi.mkMixed(5).reg.test("MIXED") -> ' + mixed.reg.test('MIXED'))
  log('await myApi.mkMixed(5).map.get("seed") -> ' + mixed.map.get('seed'))
  log('await myApi.mkMixed(5).set.has(6) -> ' + mixed.set.has(6))
  log('await myApi.mkMixed(5).ta[0] -> ' + mixed.ta[0])
  const mixedR = await mixed.test(2)
  log('await (await myApi.mkMixed(5)).test(2) -> ' + mixedR)
})()
