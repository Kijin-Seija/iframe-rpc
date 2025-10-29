export interface TestApi {
  a: number
  test: (n: number) => number
  nested: {
    a: number
    test: (n: number) => number
    nested: {
      a: number
      test: (n: number) => number
    }
  }
  testNested: (n: number) => {
    a: number
    test: (n: number) => number
  }
  // 函数嵌套函数
  mkAdder: (x: number) => (y: number) => number
  // 函数嵌套对象 + 对象嵌套对象/函数（多层组合）
  makeObj: (seed: number) => {
    val: number
    nested: {
      val: number
      fn: (n: number) => number
      deeper: {
        val: number
        fn2: (n: number) => number
      }
    }
    fn: (n: number) => {
      val: number
      deepFn: (n: number) => number
    }
  }
  testPromise: (param: number) => Promise<number>
  testNestedPromise: (param: number) => Promise<{
    val: number
    test: (param: number) => Promise<number>
  }>
}
