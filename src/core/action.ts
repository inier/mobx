import {
    IDerivation,
    endBatch,
    fail,
    globalState,
    invariant,
    isSpyEnabled,
    spyReportEnd,
    spyReportStart,
    startBatch,
    untrackedEnd,
    untrackedStart
} from "../internal"

export interface IAction {
    isMobxAction: boolean
}

export function createAction(actionName: string, fn: Function, ref?: Object): Function & IAction {
    if (process.env.NODE_ENV !== "production") {
        invariant(typeof fn === "function", "`action` can only be invoked on functions")
        if (typeof actionName !== "string" || !actionName)
            fail(`actions should have valid names, got: '${actionName}'`)
    }
    const res = function() {
        return executeAction(actionName, fn, ref || this, arguments)
    }
    ;(res as any).isMobxAction = true
    return res as any
}

export function executeAction(actionName: string, fn: Function, scope?: any, args?: IArguments) {
    const runInfo = _startAction(actionName, scope, args) // untracked 方式运行
    try {
        return fn.apply(scope, args)
    } catch (err) {
        runInfo.error = err
        throw err
    } finally {
        _endAction(runInfo)
    }
}

export interface IActionRunInfo {
    prevDerivation: IDerivation | null
    prevAllowStateChanges: boolean
    notifySpy: boolean
    startTime: number
    error?: any
    parentActionId: number
    actionId: number
}

export function _startAction(actionName: string, scope: any, args?: IArguments): IActionRunInfo {
    const notifySpy = isSpyEnabled() && !!actionName
    let startTime: number = 0
    if (notifySpy && process.env.NODE_ENV !== "production") {
        startTime = Date.now()
        const l = (args && args.length) || 0
        const flattendArgs = new Array(l)
        if (l > 0) for (let i = 0; i < l; i++) flattendArgs[i] = args![i]
        spyReportStart({
            type: "action",
            name: actionName,
            object: scope,
            arguments: flattendArgs
        })
    }
    // untrack globalState.trackingDerivation，即在 action 期间不进行依赖收集（get 代理）
    const prevDerivation = untrackedStart()
    // 锁住 inBatch，即在 action 期间也不进行实际的 runReactions
    // 期间 set 代理 push 的 globalState.pendingReactions，将在 endBatch inBatch 降为 0，依次执行
    startBatch()
    const prevAllowStateChanges = allowStateChangesStart(true) // 将允许改变设为 true
    const runInfo = {
        prevDerivation,
        prevAllowStateChanges,
        notifySpy,
        startTime,
        actionId: globalState.nextActionId++,
        parentActionId: globalState.currentActionId
    }
    globalState.currentActionId = runInfo.actionId
    return runInfo
}

export function _endAction(runInfo: IActionRunInfo) {
    if (globalState.currentActionId !== runInfo.actionId) {
        fail("invalid action stack. did you forget to finish an action?")
    }
    globalState.currentActionId = runInfo.parentActionId

    if (runInfo.error !== undefined) {
        globalState.suppressReactionErrors = true
    }
    allowStateChangesEnd(runInfo.prevAllowStateChanges)
    endBatch()
    untrackedEnd(runInfo.prevDerivation)
    if (runInfo.notifySpy && process.env.NODE_ENV !== "production") {
        spyReportEnd({ time: Date.now() - runInfo.startTime })
    }
    globalState.suppressReactionErrors = false
}

export function allowStateChanges<T>(allowStateChanges: boolean, func: () => T): T {
    const prev = allowStateChangesStart(allowStateChanges)
    let res: T
    try {
        res = func()
    } finally {
        allowStateChangesEnd(prev)
    }
    return res
}

export function allowStateChangesStart(allowStateChanges: boolean) {
    const prev = globalState.allowStateChanges
    globalState.allowStateChanges = allowStateChanges
    return prev
}

export function allowStateChangesEnd(prev: boolean) {
    globalState.allowStateChanges = prev
}

export function allowStateChangesInsideComputed<T>(func: () => T): T {
    const prev = globalState.computationDepth
    globalState.computationDepth = 0
    let res: T
    try {
        res = func()
    } finally {
        globalState.computationDepth = prev
    }
    return res
}
