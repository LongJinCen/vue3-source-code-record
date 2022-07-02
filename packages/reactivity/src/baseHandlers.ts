import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

// 创建 getter
const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

/**
 * 对于 reactive(array) 的情况，会对数组上的一些方法做一些处理，方便进行依赖收集，和派发更新
 * @returns 
 */
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 将 如果 this 指向的 array 是一个 Proxy，那么需要将其转换普通的值
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        // 依赖收集当前 arr 的每一个 key
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      // 当再响应式数组上执行 'includes', 'indexOf', 'lastIndexOf' 这几个方法时，对于 args
      // 会先尝试使用原始的 args 传递给对应的方法，如果找不到，那么如果 args 中如果有 reactive 的会将其 toRaw 处理，使用原始值进行处理

      // arr 是 toRaw 后的值，调用其上面的 key 对应的方法是原始的方法
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

// 创建 proxy 的 getter
/**
 * 
 * @param isReadonly 为 true 表示不会做依赖收集
 * @param shallow 为 true，表示访问其某个 key 对应的值时，如果是对象不会再次对其做响应式处理
 * @returns 
 */
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    // 处理读取 target 上的特殊属性应该返回哪些值
    if (key === ReactiveFlags.IS_REACTIVE) {
      // target 是不是响应式的条件：不能是 readonly
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      // target 是否是 readonly
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      // target 是否 shallow reactive
      return shallow
    } else if (
      // 对于一个 proxy，它的 __v_raw 属性表示它的原始对象，也就是 target
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)
    // 如果 target 是一个数组，并且访问的数组上的 一些方法，那么返回经过包装的这些方法
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    // 拿到对应的值
    const res = Reflect.get(target, key, receiver)

    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    // 如果不是只读的，那么当读取当前 key 时，需要 track 它的依赖
    // const proxy = ReadyOnly(xxxProxy | xxxobj), proxy.xxx 不会触发 xxx 的依赖收集，但是如果 ReadyOnly 包裹的是一个 proxy
    // 由于前面调用 Reflect.get 的时候访问了 xxxproxy 上的值，由于 xxxProxy 不是一个 readyOnly 的，所以会触发它的依赖收集
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    // 如果是 shallow 直接返回值
    if (shallow) {
      return res                                      
    }
    // 如果 res 是一个 ref，那么需要 unwrap 一下，返回其 value
    // 意味着可以使用 reactive({ value: ref(xxx) }) 可以包裹 ref
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }
    // 如果 res 是一个 object，那么需要把这个 res 转换为一个 reactive，proxy 其实也是一个 object，在转换的过程中针对 res 已经是一个 proxy 的
    // 情况，会做拦截
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }
    // 如果是一个普通的值，那么直接返回
    return res
  }
}

// 创建 setter
const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    // 拿到旧值
    let oldValue = (target as any)[key]
    // 如果设置的 key 对应的值，是一个 readonly 的值，那么设置失败
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    if (!shallow && !isReadonly(value)) {
      if (!isShallow(value)) {
        // 设置的 value 和 oldValue、value 如果也是一个 proxy，那么需要将其转换为一个普通的值
        value = toRaw(value)
        oldValue = toRaw(oldValue)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }
    // 检查 target 中是否有对应的 key
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 设置对应的值
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      // 派发更新
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

// 删除某一个属性的拦截
function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  // 删除某一个 Key 时，也会派发更新
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// xxx in obj 的拦截
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  // 当调用 xx in obj 时，也需要触发依赖收集
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

/**
 拦截以下操作
  Object.getOwnPropertyNames()
  Object.getOwnPropertySymbols()
  Object.keys()
  Reflect.ownKeys()
 */
function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

// 可更改的 handlers
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

// readyonly
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

// shallow reactive
export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
// shallow readonly
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
