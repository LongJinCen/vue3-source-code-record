import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 全局唯一的当前正在运行的 effect
export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

// effect
export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean
  /**
   * @internal
   */
  private deferStop?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T, // 该 effect 执行的函数
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    // 如果当前是非激活状态，直接执行该函数，返回结果
    if (!this.active) {
      return this.fn()
    }
    // 当前激活的 effect 作为 parent effect
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack
    // 如果 parent 为 this 指向的 effect ，那么直接 return
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      // 设置当前的 effect 的 parent effect
      this.parent = activeEffect
      // 将当前激活的 effect 设置为当前 effect
      activeEffect = this
      shouldTrack = true
      // 不断左移，最多左移 30 位，effectTrackDepth 表示嵌套层级
      trackOpBit = 1 << ++effectTrackDepth

      if (effectTrackDepth <= maxMarkerBits) {
        initDepMarkers(this)
      } else {
        cleanupEffect(this)
      }
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        finalizeDepMarkers(this)
      }
      // 执行完成后嵌套层级减一
      trackOpBit = 1 << --effectTrackDepth
      // 退出当前 effect 的执行，activeEffect 为 parent
      activeEffect = this.parent
      shouldTrack = lastShouldTrack
      this.parent = undefined

      if (this.deferStop) {
        this.stop()
      }
    }
  }

  stop() {
    // stopped while running itself - defer the cleanup
    // 当当前的 activeEffect 等于自己时，说明 run 方法还没有执行完，将标志位 deferStop 置为 true 即可
    if (activeEffect === this) {
      this.deferStop = true
    } else if (this.active) {
      // 清楚 effect
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      // active 置为 false
      this.active = false
    }
  }
}

// 从 effect 的所有 deps 中删除此 effect
function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

// effect 函数
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }
  // 根据传入的 fn，实例化一个 effect
  const _effect = new ReactiveEffect(fn)
  // 如果传递了 options，合并 _effect 和 options
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 如果没有配置 lazy 行为，那么立即 run effect
  if (!options || !options.lazy) {
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

// 清楚 effect 即相关依赖对 effect 的收集
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
const trackStack: boolean[] = []

// 暂停 track
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

// 启用 track
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

// 重置 track
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 进行依赖收集
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 只有 shouldTrack 为 true，并且当前又 activeEffect 时，才进行依赖收集
  if (shouldTrack && activeEffect) {
    // 获取 target 对应的 map
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      // 如果没有 map 就新建一个。target => map
      targetMap.set(target, (depsMap = new Map()))
    }
    // target 中的每一个 key 也需要有一个 map， key => Dep
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined
    // 根据新建的 dep，进行依赖收集
    trackEffects(dep, eventInfo)
  }
}
// 进行依赖收集
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      // 给 dep.n 的标志位加上当期 effect 的 trackOpBit，表示当前的这个 effect 是新 tracked 的
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep) // 如果当前 dep 之前没有 track 过这个 effect，那么 shouldTrack 为 true
    }
  } else {
    // Full cleanup mode.
    // 判断 dep 中是否有当前的 acctiveEffect
    shouldTrack = !dep.has(activeEffect!)
  }
  // shouldTrack 为 true 时才进行依赖收集
  if (shouldTrack) {
    // 将 activeEffect 添加到 dep 中
    dep.add(activeEffect!)
    // 将 dep 添加到 effect 中，形成互相引用
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack({
        effect: activeEffect!,
        ...debuggerEventExtraInfo!
      })
    }
  }
}

// 派发更新
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 根据 target 获取到对应的 map
  const depsMap = targetMap.get(target)
  // 如果没有 map，该 target 没有进行过依赖收集，也就是没有 effect 需要重新 run
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  // 如果执行的是清除操作，那么 target 是一个 collection，清楚该 collection，需要触发该 target 所有的 effect 运行
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  // 如果设置的是 length 属性，并且 target 是一个数组
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      // 只派发 length 属性的 dep 和 key 大于 length 的 index 的 dep
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 取到某一个具体的 key 对应的 dep
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    /**
      const a = reactive({ a: 1, b: 1 })
      effect(() => {
        console.log(Object.keys(a))
      })
      setTimeout(() => {
        a.d = 4 // 当新增一个 key 时，由于 effect 中通过 Object.keys 访问了 a，所以会进行依赖收集，当 a 的 key 发生改变后也需要触发迭代器相关的 effect 重新运行
      }, 2000)
     */
    switch (type) {
      // 新增某一个 key
      case TriggerOpTypes.ADD:
        // 如果不是 数组
        if (!isArray(target)) {
          // 对于普通对象，拿到其迭代器的 deps
          deps.push(depsMap.get(ITERATE_KEY))
          // 如果是一个 map
          if (isMap(target)) {
            // 拿到 map 迭代器的 deps
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        // 如果是一个数组，那么这里就是新增一个 index，拿到 length 属性对应的 deps
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      // 删除某一个 key
      case TriggerOpTypes.DELETE:
        // 如果不是数组
        if (!isArray(target)) {
          // 对于普通对象，拿到其迭代器的 deps
          deps.push(depsMap.get(ITERATE_KEY))
          // 如果是一个 map
          if (isMap(target)) {
            // 拿到 map 迭代器的 deps
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      // 更新某一个 key
      case TriggerOpTypes.SET:
        // 如果是一个 map
        if (isMap(target)) {
          // 拿到 map 迭代器的 deps
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined
  // 触发所有的 effects
  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

// 触发 effect 的执行
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  const effects = isArray(dep) ? dep : [...dep]
  for (const effect of effects) {
    // 先运行 computed 的 effect
    if (effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
  for (const effect of effects) {
    // 再运行普通的 effect
    if (!effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
}

function triggerEffect(
  effect: ReactiveEffect,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  if (effect !== activeEffect || effect.allowRecurse) {
    if (__DEV__ && effect.onTrigger) {
      effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
    }
    if (effect.scheduler) {
      effect.scheduler()
    } else {
      effect.run()
    }
  }
}
