import {
    BabelDescriptor,
    IEnhancer,
    asObservableObject,
    createPropDecorator,
    fail,
    invariant,
    stringifyKey
} from "../internal"

export type IObservableDecorator = {
    (target: Object, property: string | symbol, descriptor?: PropertyDescriptor): void
    enhancer: IEnhancer<any>
}

// 通过 enhancer，来生成 一类的由该 enhancer 完成“劫持操作”的 装饰器工厂
// 在 src/api/observable.ts 63 行调用
export function createDecoratorForEnhancer(enhancer: IEnhancer<any>): IObservableDecorator {
    invariant(enhancer)
    // 在 src/api/extendobservable.ts extendObservableObjectWithProperties 的 for (const key of keys) 进入
    // 拿到该对象的所有 key（propertyName）依次劫持
    // NOTE: 被劫持对象和具体劫持的属性通过 decorator 连接
    const decorator = createPropDecorator(
        true,
        // NOTE: 传进去的函数是装饰器的代理函数，是为了拿到 enhancer
        (
            target: any,
            propertyName: PropertyKey, // 具体被装饰的名称：@observable propertyName
            descriptor: BabelDescriptor | undefined,
            _decoratorTarget,
            decoratorArgs: any[]
        ) => {
            if (process.env.NODE_ENV !== "production") {
                invariant(
                    !descriptor || !descriptor.get,
                    `@observable cannot be used on getter (property "${stringifyKey(
                        propertyName
                    )}"), use @computed instead.`
                )
            }
            const initialValue = descriptor
                ? descriptor.initializer
                    ? descriptor.initializer.call(target)
                    : descriptor.value
                : undefined
            // 传入 target（当前被劫持的对象），拿到 ObservableObjectAdministration，
            // 里面封装着劫持和操作的 api（实际上是调用 ObservableValue 的 api）
            // 再调用 addObservableProp 方法，将 propertyName（当前对象的属性）通过 enhancer 赋 initialValue 进行劫持
            // NOTE: 每次劫持相同 target（obj） 的属性, propertyName 都调用同一个 adm，因此 adm.values 存储着该对象的所有 key
            asObservableObject(target).addObservableProp(propertyName, initialValue, enhancer)
        }
    )
    const res: any =
        // Extra process checks, as this happens during module initialization
        typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production"
            ? function observableDecorator() {
                    // This wrapper function is just to detect illegal decorator invocations, deprecate in a next version
                    // and simply return the created prop decorator
                    if (arguments.length < 2)
                        return fail(
                          "Incorrect decorator invocation. @observable decorator doesn't expect any arguments"
                        )
                    // 非 production 模式下，做一层判断，返回 descriptor
                    return decorator.apply(null, arguments)
              }
            : decorator
    // 把 enhancer 挂上去，方便后面使用（也可以看成是一种标志，见 createDecoratorForEnhancer 上的注释）
    res.enhancer = enhancer
    return res
}
