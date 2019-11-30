import {
    Lambda,
    ComputedValue,
    IDependencyTree,
    IDerivation,
    IDerivationState,
    TraceMode,
    getDependencyTree,
    globalState,
    runReactions
} from "../internal"

export interface IDepTreeNode {
    name: string
    observing?: IObservable[]
}

export interface IObservable extends IDepTreeNode {
    diffValue: number
    /**
     * Id of the derivation *run* that last accessed this observable.
     * If this id equals the *run* id of the current derivation,
     * the dependency is already established
     */
    lastAccessedBy: number
    isBeingObserved: boolean

    lowestObserverState: IDerivationState // Used to avoid redundant propagations
    isPendingUnobservation: boolean // Used to push itself to global.pendingUnobservations at most once per batch.

    observers: Set<IDerivation>

    onBecomeUnobserved(): void
    onBecomeObserved(): void

    onBecomeUnobservedListeners: Set<Lambda> | undefined
    onBecomeObservedListeners: Set<Lambda> | undefined
}

export function hasObservers(observable: IObservable): boolean {
    return observable.observers && observable.observers.size > 0
}

export function getObservers(observable: IObservable): Set<IDerivation> {
    return observable.observers
}

// function invariantObservers(observable: IObservable) {
//     const list = observable.observers
//     const map = observable.observersIndexes
//     const l = list.length
//     for (let i = 0; i < l; i++) {
//         const id = list[i].__mapid
//         if (i) {
//             invariant(map[id] === i, "INTERNAL ERROR maps derivation.__mapid to index in list") // for performance
//         } else {
//             invariant(!(id in map), "INTERNAL ERROR observer on index 0 shouldn't be held in map.") // for performance
//         }
//     }
//     invariant(
//         list.length === 0 || Object.keys(map).length === list.length - 1,
//         "INTERNAL ERROR there is no junk in map"
//     )
// }
export function addObserver(observable: IObservable, node: IDerivation) {
    // invariant(node.dependenciesState !== -1, "INTERNAL ERROR, can add only dependenciesState !== -1");
    // invariant(observable._observers.indexOf(node) === -1, "INTERNAL ERROR add already added node");
    // invariantObservers(observable);

    observable.observers.add(node)
    // bindDependencies 中调用 addObserver 时，f.call() 已经收集完 node 的依赖
    // 所以 observable 的状态不能高于 node
    if (observable.lowestObserverState > node.dependenciesState)
        observable.lowestObserverState = node.dependenciesState

    // invariantObservers(observable);
    // invariant(observable._observers.indexOf(node) !== -1, "INTERNAL ERROR didn't add node");
}

export function removeObserver(observable: IObservable, node: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR, remove should be called only inside batch");
    // invariant(observable._observers.indexOf(node) !== -1, "INTERNAL ERROR remove already removed node");
    // invariantObservers(observable);
    observable.observers.delete(node)
    if (observable.observers.size === 0) {
        // deleting last observer
        queueForUnobservation(observable)
    }
    // invariantObservers(observable);
    // invariant(observable._observers.indexOf(node) === -1, "INTERNAL ERROR remove already removed node2");
}

export function queueForUnobservation(observable: IObservable) {
    if (observable.isPendingUnobservation === false) {
        // invariant(observable._observers.length === 0, "INTERNAL ERROR, should only queue for unobservation unobserved observables");
        observable.isPendingUnobservation = true
        globalState.pendingUnobservations.push(observable)
    }
}

/**
 * Batch starts a transaction, at least for purposes of memoizing ComputedValues when nothing else does.
 * During a batch `onBecomeUnobserved` will be called at most once per observable.
 * Avoids unnecessary recalculations.
 */
export function startBatch() {
    globalState.inBatch++
}

export function endBatch() {
    if (--globalState.inBatch === 0) {
        runReactions()
        // the batch is actually about to finish, all unobserving should happen here.
        const list = globalState.pendingUnobservations
        for (let i = 0; i < list.length; i++) {
            const observable = list[i]
            observable.isPendingUnobservation = false
            if (observable.observers.size === 0) {
                if (observable.isBeingObserved) {
                    // if this observable had reactive observers, trigger the hooks
                    observable.isBeingObserved = false
                    // 遍历 unobservedListeners
                    observable.onBecomeUnobserved()
                }
                if (observable instanceof ComputedValue) {
                    // computed values are automatically teared down when the last observer leaves
                    // this process happens recursively, this computed might be the last observabe of another, etc..
                    observable.suspend()
                }
            }
        }
        globalState.pendingUnobservations = []
    }
}

export function reportObserved(observable: IObservable): boolean {
    // NOTE: get 代理，通过这里将 observable 上报给正在收集依赖的 reaction
    // 而 reaction 是通过 reaction.schedule push 到 globalState 中的
    const derivation = globalState.trackingDerivation
    // 判断当前是否有 track 的 reaction，如果没有（可能是包在 untracked 中执行的），则退出
    if (derivation !== null) {
        /**
         * Simple optimization, give each derivation run an unique id (runId)
         * Check if last time this observable was accessed the same runId is used
         * if this is the case, the relation is already known
         */
        if (derivation.runId !== observable.lastAccessedBy) {
            // 将 lastAccessedBy 置为 runId，标志着这轮收集依赖，这个 observable 已经处理过了
            observable.lastAccessedBy = derivation.runId
            // Tried storing newObserving, or observing, or both as Set, but performance didn't come close...
            derivation.newObserving![derivation.unboundDepsCount++] = observable
            // computedValue 依赖的 observableValue 在 reaction 中可能已经处理了
            if (!observable.isBeingObserved) {
                observable.isBeingObserved = true
                observable.onBecomeObserved()
            }
        }
        return true
    } else if (observable.observers.size === 0 && globalState.inBatch > 0) {
        queueForUnobservation(observable)
    }
    return false
}

// function invariantLOS(observable: IObservable, msg: string) {
//     // it's expensive so better not run it in produciton. but temporarily helpful for testing
//     const min = getObservers(observable).reduce((a, b) => Math.min(a, b.dependenciesState), 2)
//     if (min >= observable.lowestObserverState) return // <- the only assumption about `lowestObserverState`
//     throw new Error(
//         "lowestObserverState is wrong for " +
//             msg +
//             " because " +
//             min +
//             " < " +
//             observable.lowestObserverState
//     )
// }

/**
 * NOTE: current propagation mechanism will in case of self reruning autoruns behave unexpectedly
 * It will propagate changes to observers from previous run
 * It's hard or maybe impossible (with reasonable perf) to get it right with current approach
 * Hopefully self reruning autoruns aren't a feature people should depend on
 * Also most basic use cases should be ok
 */

// Called by Atom when its value changes
export function propagateChanged(observable: IObservable) {
    // invariantLOS(observable, "changed start");
    if (observable.lowestObserverState === IDerivationState.STALE) return
    // 有值改变 lowestObserverState 就置为 STALE，并通知给依赖它的 derivation
    observable.lowestObserverState = IDerivationState.STALE

    // Ideally we use for..of here, but the downcompiled version is really slow...
    observable.observers.forEach(d => {
        if (d.dependenciesState === IDerivationState.UP_TO_DATE) {
            if (d.isTracing !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            d.onBecomeStale()
        }
        d.dependenciesState = IDerivationState.STALE
    })
    // invariantLOS(observable, "changed end");
}

// Called by ComputedValue when it recalculate and its value changed
export function propagateChangeConfirmed(observable: IObservable) {
    // invariantLOS(observable, "confirmed start");
    if (observable.lowestObserverState === IDerivationState.STALE) return
    observable.lowestObserverState = IDerivationState.STALE

    // autorun 中打印 computedValue：第一次 computedValue 计算完自己的依赖后，reaction 还没有开始依赖它
    observable.observers.forEach(d => {
        // computedValue 经计算后确认为 STALE，那依赖它的 derivation 也变为 STALE
        if (d.dependenciesState === IDerivationState.POSSIBLY_STALE)
            d.dependenciesState = IDerivationState.STALE
        // 如果刚好是在计算 d 时（状态为 UP_TO_DATE），computedValue 递归并提交改变 的话
        // 需要恢复 changeDependenciesStateTo0 的工作，以便继续 trackDerivedFunction 计算 d
        else if (
            d.dependenciesState === IDerivationState.UP_TO_DATE // this happens during computing of `d`, just keep lowestObserverState up to date.
        )
            observable.lowestObserverState = IDerivationState.UP_TO_DATE
    })
    // invariantLOS(observable, "confirmed end");
}

// Used by computed when its dependency changed, but we don't wan't to immediately recompute.
export function propagateMaybeChanged(observable: IObservable) {
    // invariantLOS(observable, "maybe start");
    if (observable.lowestObserverState !== IDerivationState.UP_TO_DATE) return
    observable.lowestObserverState = IDerivationState.POSSIBLY_STALE

    observable.observers.forEach(d => {
        if (d.dependenciesState === IDerivationState.UP_TO_DATE) {
            d.dependenciesState = IDerivationState.POSSIBLY_STALE
            if (d.isTracing !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            d.onBecomeStale()
        }
    })
    // invariantLOS(observable, "maybe end");
}

function logTraceInfo(derivation: IDerivation, observable: IObservable) {
    console.log(
        `[mobx.trace] '${derivation.name}' is invalidated due to a change in: '${observable.name}'`
    )
    if (derivation.isTracing === TraceMode.BREAK) {
        const lines = []
        printDepTree(getDependencyTree(derivation), lines, 1)

        // prettier-ignore
        new Function(
`debugger;
/*
Tracing '${derivation.name}'

You are entering this break point because derivation '${derivation.name}' is being traced and '${observable.name}' is now forcing it to update.
Just follow the stacktrace you should now see in the devtools to see precisely what piece of your code is causing this update
The stackframe you are looking for is at least ~6-8 stack-frames up.

${derivation instanceof ComputedValue ? derivation.derivation.toString().replace(/[*]\//g, "/") : ""}

The dependencies for this derivation are:

${lines.join("\n")}
*/
    `)()
    }
}

function printDepTree(tree: IDependencyTree, lines: string[], depth: number) {
    if (lines.length >= 1000) {
        lines.push("(and many more)")
        return
    }
    lines.push(`${new Array(depth).join("\t")}${tree.name}`) // MWE: not the fastest, but the easiest way :)
    if (tree.dependencies) tree.dependencies.forEach(child => printDepTree(child, lines, depth + 1))
}
