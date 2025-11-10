/**
 * 共享工具方法合集：供客户端与服务端同时使用。
 * 纯函数实现，与具体实例状态解耦。
 */

// 基础类型判定与品牌
/**
 * 判断值是否为非 null 的对象。
 * @param val 任意值
 * @returns 是否为对象
 */
export function isObject(val: any): boolean {
  return val !== null && typeof val === 'object'
}

/**
 * 返回值的品牌标记（Object.prototype.toString）。
 * @param val 任意值
 * @returns 形如 "[object Type]" 的字符串
 */
export function brandTag(val: any): string {
  return Object.prototype.toString.call(val)
}

/**
 * 判断值是否为 TypedArray 或 DataView 等 ArrayBuffer 视图。
 * @param val 任意值
 * @returns 是否为 TypedArray 视图
 */
export function isTypedArray(val: any): boolean {
  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(val)
}

// 唯一 ID 生成
/**
 * 生成跨线程足够唯一的 ID（时间戳 + 随机段）。
 * @returns 唯一 ID 字符串
 */
export function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// 结构化克隆直传类型判定
/**
 * 判断值是否属于结构化克隆可直传类型（无需自定义序列化）。
 * 包括 Date、RegExp、ArrayBuffer、DataView、Blob、File、ImageData、Map、Set、TypedArray。
 * @param val 任意值
 * @returns 是否可直传
 */
export function isStructuredClonePassThrough(val: any): boolean {
  if (!val || typeof val !== 'object') return false
  const tag = brandTag(val)
  if (
    tag === '[object Date]' ||
    tag === '[object RegExp]' ||
    tag === '[object ArrayBuffer]' ||
    tag === '[object DataView]' ||
    tag === '[object Blob]' ||
    tag === '[object File]' ||
    tag === '[object ImageData]'
  ) return true
  if (tag === '[object Map]' || tag === '[object Set]') return true
  if (isTypedArray(val)) return true
  return false
}

// 路径读写与序列化工具
/**
 * 按点路径读取对象深层属性。
 * 支持 'a.b.c'；路径为空返回对象本身，任一中间值不存在返回 undefined。
 * @param obj 根对象
 * @param path 点分路径
 * @returns 读取到的值或 undefined
 */
export function getDeep(obj: any, path: string): any {
  if (!path) return obj
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (!cur) return undefined
    cur = cur[p]
  }
  return cur
}

/**
 * 将错误序列化为字符串，优先使用 Error.message。
 * @param err 任意错误或值
 * @returns 可打印字符串
 */
export function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

// 值快照与函数路径收集（服务端使用）
/**
 * 列出对象的可读键集合（自有属性 + 带 getter 的属性 + 原型链 getter）。
 * 结构化克隆直传类型不列出键。
 * @param obj 目标对象
 * @returns 键名列表
 */
export function listReadableKeys(obj: any): string[] {
  if (!isObject(obj)) return []
  if (isStructuredClonePassThrough(obj)) return []
  const set = new Set<string>()
  for (const k of Object.keys(obj)) set.add(k)
  try {
    for (const k of Object.getOwnPropertyNames(obj)) {
      if (set.has(k)) continue
      const desc = Object.getOwnPropertyDescriptor(obj, k)
      if (desc && typeof desc.get === 'function') set.add(k)
    }
  } catch {}
  try {
    let proto = Object.getPrototypeOf(obj)
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor' || set.has(k)) continue
        const desc = Object.getOwnPropertyDescriptor(proto, k)
        if (desc && typeof desc.get === 'function') set.add(k)
      }
      proto = Object.getPrototypeOf(proto)
    }
  } catch {}
  return Array.from(set)
}

/**
 * 列出对象上可用于函数路径收集的键（可读键 + 原型链上 value 为函数的键）。
 * 结构化克隆直传类型不列出键。
 * @param obj 目标对象
 * @returns 键名列表
 */
export function listFunctionKeysForCollect(obj: any): string[] {
  if (!isObject(obj)) return []
  if (isStructuredClonePassThrough(obj)) return []
  const set = new Set<string>()
  for (const k of listReadableKeys(obj)) set.add(k)
  try {
    let proto = Object.getPrototypeOf(obj)
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor' || set.has(k)) continue
        const desc = Object.getOwnPropertyDescriptor(proto, k)
        if (desc && typeof desc.value === 'function') set.add(k)
      }
      proto = Object.getPrototypeOf(proto)
    }
  } catch {}
  return Array.from(set)
}

/**
 * 递归收集对象中的函数路径，返回 'a.b.fn' 形式列表。
 * 避免循环引用，通过 WeakSet 去重。
 * @param obj 根对象
 * @param base 前缀路径（内部使用）
 * @param out 输出数组（内部使用）
 * @param visited 访问集合（内部使用）
 * @returns 函数路径列表
 */
export function collectFunctionPaths(
  obj: any,
  base: string[] = [],
  out: string[] = [],
  visited: WeakSet<object> = new WeakSet(),
): string[] {
  if (!isObject(obj)) return out
  if (visited.has(obj as object)) return out
  visited.add(obj as object)
  for (const key of listFunctionKeysForCollect(obj)) {
    let v: any
    try { v = Reflect.get(obj as any, key) } catch { continue }
    const path = [...base, key]
    if (typeof v === 'function') out.push(path.join('.'))
    else if (isObject(v)) collectFunctionPaths(v, path, out, visited)
  }
  return out
}

/**
 * 深克隆对象但仅保留值（函数被丢弃为 undefined）。
 * 对 Map/Set/TypedArray 等直传类型保持结构（Map/Set 递归克隆键和值）。
 * 使用 WeakMap 处理循环引用。
 * @param obj 任意值
 * @param seen 克隆缓存（内部使用）
 * @returns 克隆后的值
 */
export function cloneValuesOnly(obj: any, seen: WeakMap<object, any> = new WeakMap()): any {
  if (typeof obj === 'function') return undefined
  if (!isObject(obj)) return obj
  if (isStructuredClonePassThrough(obj)) {
    const tag = brandTag(obj)
    const existing = seen.get(obj as object)
    if (existing) return existing
    if (tag === '[object Map]') {
      const outMap = new Map<any, any>()
      seen.set(obj as object, outMap)
      ;(obj as Map<any, any>).forEach((v, k) => {
        const ck = cloneValuesOnly(k, seen)
        const cv = cloneValuesOnly(v, seen)
        outMap.set(ck, cv)
      })
      return outMap
    }
    if (tag === '[object Set]') {
      const outSet = new Set<any>()
      seen.set(obj as object, outSet)
      ;(obj as Set<any>).forEach((v) => {
        const cv = cloneValuesOnly(v, seen)
        outSet.add(cv)
      })
      return outSet
    }
    seen.set(obj as object, obj)
    return obj
  }
  const existing = seen.get(obj as object)
  if (existing) return existing
  if (Array.isArray(obj)) {
    const outArr: any[] = []
    seen.set(obj as object, outArr)
    for (let i = 0; i < obj.length; i++) {
      outArr[i] = cloneValuesOnly(obj[i], seen)
    }
    return outArr
  }
  const outObj: Record<string, any> = {}
  seen.set(obj as object, outObj)
  for (const key of listReadableKeys(obj)) {
    let v: any
    try { v = Reflect.get(obj as any, key) } catch { continue }
    if (typeof v === 'function') continue
    outObj[key] = cloneValuesOnly(v, seen)
  }
  return outObj
}

// 客户端使用：建立对象的规范路径索引（避免循环与别名）
/**
 * 构建对象的规范路径索引，记录每个对象引用首次出现的路径。
 * 用于客户端物化阶段解决循环与别名路径问题。
 * @param root 根对象
 * @returns WeakMap：对象 -> 规范路径字符串
 */
export function buildCanonicalIndex(root: any): WeakMap<object, string> {
  const idx = new WeakMap<object, string>()
  const visited = new WeakSet<object>()
  const walk = (obj: any, path: string) => {
    if (!obj || typeof obj !== 'object') return
    if (isStructuredClonePassThrough(obj)) {
      if (!idx.has(obj as object)) idx.set(obj as object, path)
      return
    }
    if (visited.has(obj as object)) return
    visited.add(obj as object)
    if (!idx.has(obj as object)) idx.set(obj as object, path)
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) walk(obj[i], path ? `${path}.${i}` : String(i))
    } else {
      for (const key of Object.keys(obj)) walk(obj[key], path ? `${path}.${key}` : key)
    }
  }
  walk(root, '')
  return idx
}
