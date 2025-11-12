import { describe, it, expect } from 'vitest'
import { getDeep, brandTag, isTypedArray, isStructuredClonePassThrough, buildCanonicalIndex, isObject, serializeError, listReadableKeys, listFunctionKeysForCollect, collectFunctionPaths, cloneValuesOnly } from '../shared/utils.ts'

describe('getDeep', () => {
  it('reads nested object path', () => {
    const obj = { a: { b: 2 } }
    expect(getDeep(obj, 'a.b')).toBe(2)
  })
  it('reads array index path', () => {
    const arr = [0, { x: 1 }]
    expect(getDeep(arr, '1.x')).toBe(1)
  })
  it('returns undefined for missing path', () => {
    const obj = { a: {} }
    expect(getDeep(obj, 'a.b.c')).toBeUndefined()
  })
  it('returns root when path is empty', () => {
    const obj = { a: 1 }
    expect(getDeep(obj, '')).toBe(obj)
  })
})

describe('brandTag', () => {
  it('returns correct tag for primitives and objects', () => {
    expect(brandTag(1)).toBe('[object Number]')
    expect(brandTag('x')).toBe('[object String]')
    expect(brandTag(new Date())).toBe('[object Date]')
    expect(brandTag(new Map())).toBe('[object Map]')
    expect(brandTag(new Uint8Array(1))).toBe('[object Uint8Array]')
  })
})

describe('isTypedArray', () => {
  it('detects typed arrays and DataView', () => {
    expect(isTypedArray(new Uint8Array(2))).toBe(true)
    expect(isTypedArray(new Int16Array(1))).toBe(true)
    expect(isTypedArray(new DataView(new ArrayBuffer(8)))).toBe(true)
  })
  it('returns false for plain objects and arrays', () => {
    expect(isTypedArray({})).toBe(false)
    expect(isTypedArray([])).toBe(false)
  })
})

describe('isStructuredClonePassThrough', () => {
  it('returns true for pass-through types', () => {
    expect(isStructuredClonePassThrough(new Date())).toBe(true)
    expect(isStructuredClonePassThrough(/x/)).toBe(true)
    expect(isStructuredClonePassThrough(new ArrayBuffer(8))).toBe(true)
    expect(isStructuredClonePassThrough(new DataView(new ArrayBuffer(8)))).toBe(true)
    expect(isStructuredClonePassThrough(new Map())).toBe(true)
    expect(isStructuredClonePassThrough(new Set())).toBe(true)
    expect(isStructuredClonePassThrough(new Uint8Array(2))).toBe(true)
  })
  it('returns false for non-pass-through types', () => {
    expect(isStructuredClonePassThrough(null)).toBe(false)
    expect(isStructuredClonePassThrough({})).toBe(false)
    expect(isStructuredClonePassThrough(() => {})).toBe(false)
  })
})

describe('buildCanonicalIndex', () => {
  it('indexes objects and pass-through values with canonical paths', () => {
    const inner = { y: 2 }
    const date = new Date()
    const ta = new Uint8Array(2)
    const m = new Map()
    const root: any = { a: inner, x: inner, ta, m, arr: [inner, date] }
    const idx = buildCanonicalIndex(root)
    expect(idx.get(root)).toBe('')
    expect(['a', 'arr.0']).toContain(idx.get(inner))
    expect(idx.get(ta)).toBe('ta')
    expect(idx.get(m)).toBe('m')
    expect(idx.get(date)).toBe('arr.1')
  })
})

describe('isObject', () => {
  it('returns true for objects, arrays and dates', () => {
    expect(isObject({})).toBe(true)
    expect(isObject([])).toBe(true)
    expect(isObject(new Date())).toBe(true)
  })
  it('returns false for null and primitives', () => {
    expect(isObject(null)).toBe(false)
    expect(isObject(1)).toBe(false)
    expect(isObject('x')).toBe(false)
  })
})

describe('serializeError', () => {
  it('serializes Error message', () => {
    const e = new Error('boom')
    expect(serializeError(e)).toBe('boom')
  })
  it('serializes plain object to JSON', () => {
    expect(serializeError({ a: 1 })).toBe('{"a":1}')
  })
  it('fallbacks to String on circular object', () => {
    const a: any = {}
    a.self = a
    expect(serializeError(a)).toBe('[object Object]')
  })
})

describe('listReadableKeys', () => {
  it('includes enumerable keys and getters', () => {
    class Foo {
      private _y = 2
      get y() { return this._y }
      x = 1
    }
    const keys = listReadableKeys(new Foo())
    expect(keys).toEqual(expect.arrayContaining(['x', 'y']))
  })
  it('returns empty for pass-through types', () => {
    expect(listReadableKeys(new Date())).toEqual([])
  })
})

describe('listFunctionKeysForCollect', () => {
  it('includes readable keys and prototype functions', () => {
    class A {
      x = 1
      foo() { return 1 }
    }
    const keys = listFunctionKeysForCollect(new A())
    expect(keys).toEqual(expect.arrayContaining(['x', 'foo']))
  })
  it('returns empty for pass-through types', () => {
    expect(listFunctionKeysForCollect(new Uint8Array(1))).toEqual([])
  })
})

describe('collectFunctionPaths', () => {
  it('collects nested function paths', () => {
    const obj = { nested: { fn() {}, inner: { g() {} } } }
    const paths = collectFunctionPaths(obj).sort()
    expect(paths).toEqual(['nested.fn', 'nested.inner.g'])
  })
})

describe('cloneValuesOnly', () => {
  it('removes functions and clones nested values', () => {
    const obj: any = { x: 1, f() {}, nested: { y: 2, g() {} } }
    const cloned = cloneValuesOnly(obj)
    expect(cloned).toEqual({ x: 1, nested: { y: 2 } })
    expect('f' in cloned).toBe(false)
    expect('g' in cloned.nested).toBe(false)
  })
  it('passes through typed arrays', () => {
    const ta = new Uint8Array([1, 2])
    expect(cloneValuesOnly(ta)).toBe(ta)
  })
  it('clones Map deeply', () => {
    const m = new Map<any, any>([[{ a: 1 }, { b: 2, f() {} }]])
    const cloned = cloneValuesOnly(m) as Map<unknown, unknown>
    expect(cloned).not.toBe(m)
    const entries = Array.from(cloned.entries())
    expect(entries.length).toBe(1)
    const [k, v] = entries[0]
    expect(isObject(k)).toBe(true)
    expect(v).toEqual({ b: 2 })
  })
})
