import {
    $mobx,
    IReactionDisposer,
    Lambda,
    autorun,
    createAction,
    fail,
    getNextId
} from "../internal"

export interface IWhenOptions {
    name?: string
    timeout?: number
    onError?: (error: any) => void
}

export function when(
    predicate: () => boolean,
    opts?: IWhenOptions
): Promise<void> & { cancel(): void }
export function when(
    predicate: () => boolean,
    effect: Lambda,
    opts?: IWhenOptions
): IReactionDisposer
export function when(predicate: any, arg1?: any, arg2?: any): any {
    if (arguments.length === 1 || (arg1 && typeof arg1 === "object"))
        // 没有传 effect 会返回一个 promise，供 async await 使用
        return whenPromise(predicate, arg1)
    return _when(predicate, arg1, arg2 || {})
}

function _when(predicate: () => boolean, effect: Lambda, opts: IWhenOptions): IReactionDisposer {
    let timeoutHandle: any
    if (typeof opts.timeout === "number") {
        timeoutHandle = setTimeout(() => {
            if (!disposer[$mobx].isDisposed) {
                disposer()
                const error = new Error("WHEN_TIMEOUT")
                if (opts.onError) opts.onError(error)
                else throw error
            }
        }, opts.timeout)
    }

    opts.name = opts.name || "When@" + getNextId()
    // 副作用可能引起值改变，用 action 包住
    const effectAction = createAction(opts.name + "-effect", effect as Function)
    const disposer = autorun(r => {
        // 返回真，才执行 effect
        if (predicate()) {
            r.dispose()
            if (timeoutHandle) clearTimeout(timeoutHandle)
            effectAction()
        }
    }, opts)
    return disposer
}

function whenPromise(
    predicate: () => boolean,
    opts?: IWhenOptions
): Promise<void> & { cancel(): void } {
    if (process.env.NODE_ENV !== "production" && opts && opts.onError)
        return fail(`the options 'onError' and 'promise' cannot be combined`)
    let cancel
    const res = new Promise((resolve, reject) => {
        let disposer = _when(predicate, resolve, { ...opts, onError: reject })
        cancel = () => {
            disposer()
            reject("WHEN_CANCELLED")
        }
    })
    ;(res as any).cancel = cancel
    return res as any
}
