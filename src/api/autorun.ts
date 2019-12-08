import {
    EMPTY_OBJECT,
    IEqualsComparer,
    IReactionDisposer,
    IReactionPublic,
    Lambda,
    Reaction,
    action,
    comparer,
    getNextId,
    invariant,
    isAction
} from "../internal"

export interface IAutorunOptions {
    delay?: number
    name?: string
    scheduler?: (callback: () => void) => any
    onError?: (error: any) => void
}

/**
 * Creates a named reactive view and keeps it alive, so that the view is always
 * updated if one of the dependencies changes, even when the view is not further used by something else.
 * @param view The reactive view
 * @returns disposer function, which can be used to stop the view from being updated in the future.
 */
export function autorun(
    view: (r: IReactionPublic) => any, // 数据变化后需要执行的函数，入参为 Reaction
    opts: IAutorunOptions = EMPTY_OBJECT
): IReactionDisposer {
    if (process.env.NODE_ENV !== "production") {
        invariant(typeof view === "function", "Autorun expects a function as first argument")
        invariant(
            isAction(view) === false,
            "Autorun does not accept actions since actions are untrackable"
        )
    }

    const name: string = (opts && opts.name) || (view as any).name || "Autorun@" + getNextId()
    const runSync = !opts.scheduler && !opts.delay // 检查是否同步
    let reaction: Reaction

    if (runSync) {
        // normal autorun
        reaction = new Reaction(
            name,
            // 通过 function 的方式定义函数，this 指向 Reaction
            // 大概来说，onInvalidate 的目的就是引起重新渲染，或者说是重新收集依赖
            function(this: Reaction) {
                // 调用 schedule 到这，通过 track 去执行 view
                this.track(reactionRunner)
            },
            opts.onError
        )
    } else {
        // 有自定义 scheduler、delay 的话，就用 setTimeout 包一层
        const scheduler = createSchedulerFromOptions(opts)
        // debounced autorun
        let isScheduled = false

        reaction = new Reaction(
            name,
            () => {
                if (!isScheduled) {
                    isScheduled = true
                    scheduler(() => {
                        isScheduled = false
                        if (!reaction.isDisposed) reaction.track(reactionRunner)
                    })
                }
            },
            opts.onError
        )
    }

    function reactionRunner() {
        // 入参为当前 reaction
        view(reaction)
    }

    // 将 reaction 放进全局 pendingReactions 队列里，里面会立即执行一次 view
    reaction.schedule()
    // 返回 取消订阅依赖的 disposer
    return reaction.getDisposer()
}

export type IReactionOptions = IAutorunOptions & {
    fireImmediately?: boolean
    equals?: IEqualsComparer<any>
}

const run = (f: Lambda) => f()

function createSchedulerFromOptions(opts: IReactionOptions) {
    return opts.scheduler
        ? opts.scheduler
        : opts.delay
            ? (f: Lambda) => setTimeout(f, opts.delay!)
            : run
}

// reaction api，autorun 的变种
// 粗略地讲，reaction 是 computed(expression).observe(action(sideEffect)) 或 autorun(() => action(sideEffect)(expression)) 的语法糖
export function reaction<T>(
    expression: (r: IReactionPublic) => T, // 主动申明监听的数据
    effect: (arg: T, r: IReactionPublic) => void,
    opts: IReactionOptions = EMPTY_OBJECT
): IReactionDisposer {
    if (process.env.NODE_ENV !== "production") {
        invariant(
            typeof expression === "function",
            "First argument to reaction should be a function"
        )
        invariant(typeof opts === "object", "Third argument of reactions should be an object")
    }
    const name = opts.name || "Reaction@" + getNextId()
    // 副作用可能引起值改变，用 action（untracked 和 allowStateChanges）包住
    const effectAction = action(
        name,
        opts.onError ? wrapErrorHandler(opts.onError, effect) : effect
    )
    const runSync = !opts.scheduler && !opts.delay
    const scheduler = createSchedulerFromOptions(opts)

    let firstTime = true
    let isScheduled = false
    let value: T

    const equals = (opts as any).compareStructural
        ? comparer.structural
        : opts.equals || comparer.default

    const r = new Reaction(
        name,
        () => {
            if (firstTime || runSync) {
                reactionRunner()
            } else if (!isScheduled) {
                isScheduled = true
                scheduler!(reactionRunner)
            }
        },
        opts.onError
    )

    function reactionRunner() {
        isScheduled = false // Q: move into reaction runner?
        if (r.isDisposed) return
        let changed = false
        // track 中调用 trackDerivedFunction，只会收集 expression 中的依赖，判断是否改变后单独执行 effect
        r.track(() => {
            const nextValue = expression(r)
            changed = firstTime || !equals(value, nextValue)
            value = nextValue // 通过闭包缓存 nextValue，供下次做比较
        })
        if (firstTime && opts.fireImmediately!) effectAction(value, r)
        // 与 track 分开，数据变化后才执行 effectAction
        if (!firstTime && (changed as boolean) === true) effectAction(value, r)
        if (firstTime) firstTime = false
    }

    r.schedule() // 第一次执行，最终会调 reactionRunner
    return r.getDisposer()
}

function wrapErrorHandler(errorHandler, baseFn) {
    return function() {
        try {
            return baseFn.apply(this, arguments)
        } catch (e) {
            errorHandler.call(this, e)
        }
    }
}
