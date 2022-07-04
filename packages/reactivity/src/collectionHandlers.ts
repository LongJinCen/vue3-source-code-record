import { toRaw, ReactiveFlags, toReactive, toReadonly } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { capitalize, hasOwn, hasChanged, toRawType, isMap } from '@vue/shared'

export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

const toShallow = <T extends unknown>(value: T): T => value

const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

// collections 集合的 getter 访问器
function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value
  target = (target as any)[ReactiveFlags.RAW]
  // 对于集合类型，需要取到最原始的值，然后才能调用其上面的方法
  const rawTarget = toRaw(target)
  // 对于集合类型的 key 值，也有可能是一个 proxy
  const rawKey = toRaw(key)
  // 只有不是只读的情况下才能进行依赖收集
  if (!isReadonly) {
    // 如果访问的 key 是一个 Proxy，key 和它的 rawkey 都需要做依赖收集
    if (key !== rawKey) {
      track(rawTarget, TrackOpTypes.GET, key)
    }
    track(rawTarget, TrackOpTypes.GET, rawKey)
  }
  // 原始集合类型上面的 has 方法，这里调用原型上的方法，因为 has 方法已经被包装过了
  const { has } = getProto(rawTarget)
  // 对于集合类型，他们获取到的值也需要做对应的 Proxy 处理
  const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
  // 先判断原始集合类型上是否有 key
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  // 如果 key 是一个 Proxy，并且原始集合类型中找不到对应的 proxy，那么会降级为 key 的原始类型 rawKey 去寻找是否存在对应的 rawKey
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  } else if (target !== rawTarget) {
    // #3602 readonly(reactive(Map))
    // ensure that the nested reactive `Map` can do tracking for itself
    target.get(key)
  }
}

// 包装 has 操作
function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  const target = (this as any)[ReactiveFlags.RAW]
  // 获取原始值
  const rawTarget = toRaw(target)
  // key 也要防止其是 proxy 的情况
  const rawKey = toRaw(key)
  // 非 readonly 的情况下才进行依赖收集
  if (!isReadonly) {
    if (key !== rawKey) {
      track(rawTarget, TrackOpTypes.HAS, key)
    }
    track(rawTarget, TrackOpTypes.HAS, rawKey)
  }
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}


function size(target: IterableCollections, isReadonly = false) {
  target = (target as any)[ReactiveFlags.RAW]
  // 非 readonly 的情况下才进行依赖收集
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  return Reflect.get(target, 'size', target)
}

function add(this: SetTypes, value: unknown) {
  // 添加到 value 获取其原始值
  value = toRaw(value)
  const target = toRaw(this)
  const proto = getProto(target)
  // 防止重复添加
  const hadKey = proto.has.call(target, value)
  if (!hadKey) {
    // 添加原始值
    target.add(value)
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  return this
}

function set(this: MapTypes, key: unknown, value: unknown) {
  // 设置值的时候会将其转换为原始值
  value = toRaw(value)
  // 获取集合的原始值
  const target = toRaw(this)
  const { has, get } = getProto(target)

  let hadKey = has.call(target, key)
  // 先尝试 key，key 如果是一个 Proxy，那么后面会尝试降级为 key 的原始值
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get.call(target, key)
  target.set(key, value)
  // 如果没有触发 add 的依赖收集
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  // 如果有那么就更新 key 对应的值
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return this
}

function deleteEntry(this: CollectionTypes, key: unknown) {
  const target = toRaw(this)
  const { has, get } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  const result = target.delete(key)
  // 如果有这个 key，那么触发 delete 的依赖收集
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function clear(this: IterableCollections) {
  const target = toRaw(this)
  const hadItems = target.size !== 0
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  const result = target.clear()
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}

function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    const observed = this as any
    const target = observed[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    return target.forEach((value: unknown, key: unknown) => {
      // 注意下面的注释
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}

interface Iterable {
  [Symbol.iterator](): Iterator
}

interface Iterator {
  next(value?: any): IterationResult
}

interface IterationResult {
  value: any
  done: boolean
}

function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean
) {
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const targetIsMap = isMap(rawTarget)
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    const isKeyOnly = method === 'keys' && targetIsMap
    const innerIterator = target[method](...args)
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    // 依赖收集
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    // 对于 'keys', 'values', 'entries' 这些方法，如果 collection 是一个被包装过的 Proxy，那么当调用它的这些方法时，得到的值也会被包装成对应的 proxy
    return {
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this
  }
}

function createInstrumentations() {
  const mutableInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, false)
  }

  const shallowInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, false, true)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, true)
  }

  const readonlyInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    // readonly 下，不可更改数据
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, false)
  }

  const shallowReadonlyInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    // readonly 下，不可更改数据
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, true)
  }
  // 统一创建迭代相关 method 的包装
  const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
  iteratorMethods.forEach(method => {
    mutableInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      false
    )
    readonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      false
    )
    shallowInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      true
    )
    shallowReadonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      true
    )
  })

  return [
    mutableInstrumentations,
    readonlyInstrumentations,
    shallowInstrumentations,
    shallowReadonlyInstrumentations
  ]
}

const [
  mutableInstrumentations,
  readonlyInstrumentations,
  shallowInstrumentations,
  shallowReadonlyInstrumentations
] = /* #__PURE__*/ createInstrumentations()

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  const instrumentations = shallow
    ? isReadonly
      ? shallowReadonlyInstrumentations
      : shallowInstrumentations
    : isReadonly
    ? readonlyInstrumentations
    : mutableInstrumentations

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }
    // 从 instrumentations 上获取集合上对应的方法，因为集合一般访问的都是方法
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, false)
}

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, true)
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(true, false)
}

export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*#__PURE__*/ createInstrumentationGetter(true, true)
  }

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
