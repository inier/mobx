import {
    IAtom,
    IDepTreeNode,
    IObservable,
    addObserver,
    fail,
    globalState,
    isComputedValue,
    removeObserver
} from "../internal"

export enum IDerivationState {
    // before being run or (outside batch and not being observed)
    // at this point derivation is not holding any data about dependency tree
    NOT_TRACKING = -1,
    // no shallow dependency changed since last computation
    // won't recalculate derivation
    // this is what makes mobx fast
    UP_TO_DATE = 0,
    // some deep dependency changed, but don't know if shallow dependency changed
    // will require to check first if UP_TO_DATE or POSSIBLY_STALE
    // currently only ComputedValue will propagate POSSIBLY_STALE
    //
    // having this state is second big optimization:
    // don't have to recompute on every dependency change, but only when it's needed
    POSSIBLY_STALE = 1,
    // A shallow dependency has changed since last computation and the derivation
    // will need to recompute when it's needed next.
    STALE = 2
}

export enum TraceMode {
    NONE,
    LOG,
    BREAK
}

/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode {
    observing: IObservable[]
    newObserving: null | IObservable[]
    dependenciesState: IDerivationState
    /**
     * Id of the current run of a derivation. Each time the derivation is tracked
     * this number is increased by one. This number is globally unique
     */
    runId: number
    /**
     * amount of dependencies used by the derivation in this run, which has not been bound yet.
     */
    unboundDepsCount: number
    __mapid: string
    onBecomeStale(): void
    isTracing: TraceMode
}

export class CaughtException {
    constructor(public cause: any) {
        // Empty
    }
}

export function isCaughtException(e: any): e is CaughtException {
    return e instanceof CaughtException
}

/**
 * Finds out whether any dependency of the derivation has actually changed.
 * If dependenciesState is 1 then it will recalculate dependencies,
 * if any dependency changed it will propagate it by changing dependenciesState to 2.
 *
 * By iterating over the dependencies in the same order that they were reported and
 * stopping on the first change, all the recalculations are only called for ComputedValues
 * that will be tracked by derivation. That is because we assume that if the first x
 * dependencies of the derivation doesn't change then the derivation should run the same way
 * up until accessing x-th dependency.
 */
export function shouldCompute(derivation: IDerivation): boolean {
    switch (derivation.dependenciesState) {
        case IDerivationState.UP_TO_DATE:
            return false
        case IDerivationState.NOT_TRACKING:
        case IDerivationState.STALE:
            return true
        case IDerivationState.POSSIBLY_STALE: {
            const prevUntracked = untrackedStart() // no need for those computeds to be reported, they will be picked up in trackDerivedFunction.
            const obs = derivation.observing,
                l = obs.length
            for (let i = 0; i < l; i++) {
                const obj = obs[i]
                if (isComputedValue(obj)) { // 排除 ComputedValue
                    if (globalState.disableErrorBoundaries) {
                        obj.get() // untrackedStart 下调用 get，避免收集依赖
                    } else {
                        try {
                            obj.get()
                        } catch (e) {
                            // we are not interested in the value *or* exception at this moment, but if there is one, notify all
                            untrackedEnd(prevUntracked)
                            return true
                        }
                    }
                    // if ComputedValue `obj` actually changed it will be computed and propagated to its observers.
                    // and `derivation` is an observer of `obj`
                    // invariantShouldCompute(derivation)
                    if ((derivation.dependenciesState as any) === IDerivationState.STALE) {
                        untrackedEnd(prevUntracked)
                        return true
                    }
                }
            }
            changeDependenciesStateTo0(derivation)
            untrackedEnd(prevUntracked)
            return false
        }
    }
}

// function invariantShouldCompute(derivation: IDerivation) {
//     const newDepState = (derivation as any).dependenciesState

//     if (
//         process.env.NODE_ENV === "production" &&
//         (newDepState === IDerivationState.POSSIBLY_STALE ||
//             newDepState === IDerivationState.NOT_TRACKING)
//     )
//         fail("Illegal dependency state")
// }

export function isComputingDerivation() {
    return globalState.trackingDerivation !== null // filter out actions inside computations
}

export function checkIfStateModificationsAreAllowed(atom: IAtom) {
    const hasObservers = atom.observers.size > 0
    // Should never be possible to change an observed observable from inside computed, see #798
    if (globalState.computationDepth > 0 && hasObservers)
        fail(
            process.env.NODE_ENV !== "production" &&
                `Computed values are not allowed to cause side effects by changing observables that are already being observed. Tried to modify: ${
                    atom.name
                }`
        )
    // Should not be possible to change observed state outside strict mode, except during initialization, see #563
    // 判断 enforceActions 是否允许非 action 改变
    if (!globalState.allowStateChanges && (hasObservers || globalState.enforceActions === "strict"))
        fail(
            process.env.NODE_ENV !== "production" &&
                (globalState.enforceActions
                    ? "Since strict-mode is enabled, changing observed observable values outside actions is not allowed. Please wrap the code in an `action` if this change is intended. Tried to modify: "
                    : "Side effects like changing state are not allowed at this point. Are you trying to modify state from, for example, the render function of a React component? Tried to modify: ") +
                    atom.name
        )
}

/**
 * Executes the provided function `f` and tracks which observables are being accessed.
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * as observer of any of the accessed observables.
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context: any) {
    // pre allocate array allocation + room for variation in deps
    // array will be trimmed by bindDependencies
    // NOTE: 先将 derivation 和 observing 都置为 UP_TO_DATE，方便后续判断是否处在收集依赖阶段
    changeDependenciesStateTo0(derivation)
    derivation.newObserving = new Array(derivation.observing.length + 100)
    derivation.unboundDepsCount = 0
    derivation.runId = ++globalState.runId
    const prevTracking = globalState.trackingDerivation
    globalState.trackingDerivation = derivation
    let result
    if (globalState.disableErrorBoundaries === true) {
        result = f.call(context)
    } else {
        try {
            // NOTE: 正式调用 view 函数
            // 通过 reportObserved 将依赖上报给当前 reaction，并更新到刚初始化的 newObserving 中
            // 整个 view 的调用完成 derivation 对 observableValue 的依赖收集
            result = f.call(context) // result 用于错误记录
        } catch (e) {
            result = new CaughtException(e)
        }
    }
    // 在 f() 前后缓存 trackingDerivation，因为 ComputedValue 走 get 代理时也会调用 trackDerivedFunction
    // 缓存是为了让中间进来的 derivation 能够收集到正确的依赖
    globalState.trackingDerivation = prevTracking
    // 整个 bind 完成 observableValue 对 derivation 的绑定与解绑
    bindDependencies(derivation)
    return result
}

/**
 * diffs newObserving with observing.
 * update observing to be newObserving with unique observables
 * notify observers that become observed/unobserved
 */
function bindDependencies(derivation: IDerivation) {
    // invariant(derivation.dependenciesState !== IDerivationState.NOT_TRACKING, "INTERNAL ERROR bindDependencies expects derivation.dependenciesState !== -1");
    const prevObserving = derivation.observing
    const observing = (derivation.observing = derivation.newObserving!)
    let lowestNewObservingDerivationState = IDerivationState.UP_TO_DATE

    // Go through all new observables and check diffValue: (this list can contain duplicates):
    //   0: first occurrence, change to 1 and keep it
    //   1: extra occurrence, drop it
    let i0 = 0,
        l = derivation.unboundDepsCount
    for (let i = 0; i < l; i++) {
        const dep = observing[i]
        // 通过 get 代理新收集的依赖中，如果已经 addObserver 就忽略
        if (dep.diffValue === 0) {
            dep.diffValue = 1
            if (i0 !== i) observing[i0] = dep // 有忽略的 dep 时将当前 dep 前移
            i0++
        }

        // Upcast is 'safe' here, because if dep is IObservable, `dependenciesState` will be undefined,
        // not hitting the condition
        if (((dep as any) as IDerivation).dependenciesState > lowestNewObservingDerivationState) {
            lowestNewObservingDerivationState = ((dep as any) as IDerivation).dependenciesState
        }
    }
    observing.length = i0

    derivation.newObserving = null // newObserving shouldn't be needed outside tracking (statement moved down to work around FF bug, see #614)

    // Go through all old observables and check diffValue: (it is unique after last bindDependencies)
    //   0: it's not in new observables, unobserve it
    //   1: it keeps being observed, don't want to notify it. change to 0
    l = prevObserving.length
    while (l--) {
        // 新一轮更新中，如果还依赖了这个 dep 即 observableValue 会在上面遍历 new observables 时将其 diff 置为 1
        // 这一轮更新不需要的依赖就 remove 掉
        const dep = prevObserving[l]
        if (dep.diffValue === 0) {
            removeObserver(dep, derivation)
        }
        dep.diffValue = 0
    }

    // Go through all new observables and check diffValue: (now it should be unique)
    //   0: it was set to 0 in last loop. don't need to do anything.
    //   1: it wasn't observed, let's observe it. set back to 0
    while (i0--) {
        const dep = observing[i0]
        // 筛选出正确的依赖后，如果没 observer 的就 add
        if (dep.diffValue === 1) {
            dep.diffValue = 0
            // 给 observableValue 注册 observer
            // value change 时 observable(object, array, set...) 调用 this.atom.reportChanged() 发送通知
            // foreach 通知每个 reaction 调用 onBecomeStale，也就是 schedule 方法
            addObserver(dep, derivation)
        }
    }
    // NOTE: 收集完的依赖保存到 reaction.observing 中，在 getDependencyTree api 中会调用到

    // Some new observed derivations may become stale during this derivation computation
    // so they have had no chance to propagate staleness (#916)
    if (lowestNewObservingDerivationState !== IDerivationState.UP_TO_DATE) {
        derivation.dependenciesState = lowestNewObservingDerivationState
        derivation.onBecomeStale()
    }
}

export function clearObserving(derivation: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR clearObserving should be called only inside batch");
    const obs = derivation.observing
    derivation.observing = []
    let i = obs.length
    while (i--) removeObserver(obs[i], derivation) // 取消 reaction 的订阅

    derivation.dependenciesState = IDerivationState.NOT_TRACKING
}

// see: https://cn.mobx.js.org/refguide/api.html#untracked
export function untracked<T>(action: () => T): T {
    const prev = untrackedStart()
    try {
        // untrackedStart 把 globalState.trackingDerivation 置为 null
        // 在 get 代理走 reportObserved 时便不会再收集 observableValue 的依赖
        return action()
    } finally {
        untrackedEnd(prev)
    }
}

export function untrackedStart(): IDerivation | null {
    const prev = globalState.trackingDerivation
    globalState.trackingDerivation = null
    return prev
}

export function untrackedEnd(prev: IDerivation | null) {
    globalState.trackingDerivation = prev
}

/**
 * needed to keep `lowestObserverState` correct. when changing from (2 or 1) to 0
 *
 */
export function changeDependenciesStateTo0(derivation: IDerivation) {
    if (derivation.dependenciesState === IDerivationState.UP_TO_DATE) return
    derivation.dependenciesState = IDerivationState.UP_TO_DATE

    const obs = derivation.observing
    let i = obs.length
    // 将 observing 都置为 UP_TO_DATE，方便 computedValue 进行 shouldCompute 判断
    while (i--) obs[i].lowestObserverState = IDerivationState.UP_TO_DATE
}
