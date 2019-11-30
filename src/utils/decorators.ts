import { EMPTY_ARRAY, addHiddenProp, fail } from "../internal"

export const mobxDidRunLazyInitializersSymbol = Symbol("mobx did run lazy initializers")
export const mobxPendingDecorators = Symbol("mobx pending decorators")

type DecoratorTarget = {
    [mobxDidRunLazyInitializersSymbol]?: boolean
    [mobxPendingDecorators]?: { [prop: string]: DecoratorInvocationDescription }
}

export type BabelDescriptor = PropertyDescriptor & { initializer?: () => any }

export type PropertyCreator = (
    instance: any,
    propertyName: PropertyKey,
    descriptor: BabelDescriptor | undefined,
    decoratorTarget: any,
    decoratorArgs: any[]
) => void

type DecoratorInvocationDescription = {
    prop: string
    propertyCreator: PropertyCreator
    descriptor: BabelDescriptor | undefined
    decoratorTarget: any
    decoratorArguments: any[]
}

const enumerableDescriptorCache: { [prop: string]: PropertyDescriptor } = {}
const nonEnumerableDescriptorCache: { [prop: string]: PropertyDescriptor } = {}

function createPropertyInitializerDescriptor(
    prop: string,
    enumerable: boolean
): PropertyDescriptor {
    const cache = enumerable ? enumerableDescriptorCache : nonEnumerableDescriptorCache
    return (
        cache[prop] ||
        (cache[prop] = {
            configurable: true,
            enumerable: enumerable,
            get() {
                initializeInstance(this)
                return this[prop]
            },
            set(value) {
                initializeInstance(this)
                this[prop] = value
            }
        })
    )
}

export function initializeInstance(target: any)
// 初始化 base 空对象会调用，操作该对象也会调用
export function initializeInstance(target: DecoratorTarget) {
    if (target[mobxDidRunLazyInitializersSymbol] === true) return
    const decorators = target[mobxPendingDecorators]
    if (decorators) {
        addHiddenProp(target, mobxDidRunLazyInitializersSymbol, true)
        for (let key in decorators) {
            const d = decorators[key]
            d.propertyCreator(target, d.prop, d.descriptor, d.decoratorTarget, d.decoratorArguments)
        }
    }
}

// 该方法为生产装饰器工厂的函数，主要是根据不同的 enhancer 生产对应类型的装饰器工厂
export function createPropDecorator(
    propertyInitiallyEnumerable: boolean,
    propertyCreator: PropertyCreator // 装饰器的代理函数
) {
    // 装饰器工厂，生成一类的由该 enhancer 完成“劫持操作”的装饰器：@observable，@computed ...
    return function decoratorFactory() {
        let decoratorArguments: any[]

        // class A {
        //     @observable(decoratorArguments) a = 1 
        // }
        // NOTE: 真正的装饰器函数
        const decorator = function decorate(
            target: DecoratorTarget,
            prop: string,
            descriptor: BabelDescriptor | undefined,
            applyImmediately?: any
            // This is a special parameter to signal the direct application of a decorator, allow extendObservable to skip the entire type decoration part,
            // as the instance to apply the decorator to equals the target
        ) {
            if (applyImmediately === true) {
                // 传进来的为装饰器的代理函数，所以传参会相近且多余 decorator
                propertyCreator(target, prop, descriptor, target, decoratorArguments)
                return null
            }
            if (process.env.NODE_ENV !== "production" && !quacksLikeADecorator(arguments))
                fail("This function is a decorator, but it wasn't invoked like a decorator")
            if (!Object.prototype.hasOwnProperty.call(target, mobxPendingDecorators)) {
                const inheritedDecorators = target[mobxPendingDecorators]
                addHiddenProp(target, mobxPendingDecorators, { ...inheritedDecorators })
            }
            // 缓存 decorators，调用属性时才在 initializeInstance 正式挂上
            target[mobxPendingDecorators]![prop] = {
                prop,
                propertyCreator, // 在 initializeInstance 中调用
                descriptor,
                decoratorTarget: target,
                decoratorArguments
            }
            // 返回 descriptor，为 cache 做代理
            return createPropertyInitializerDescriptor(prop, propertyInitiallyEnumerable)
        }

        // @decorator
        if (quacksLikeADecorator(arguments)) {
            decoratorArguments = EMPTY_ARRAY
            // 如果是没加括号形式，则直接执行，让 decoratorFactory 返回 descriptor
            // NOTE: 所以可看成 decoratorFactory 代理 decorator 的功能
            return decorator.apply(null, arguments as any)
        } else {
            // @decorator(args) // args 为 function decorate 的参数
            // 直接返回 decorator（即让 decoratorFactory 执行后返回 decorator）
            // 具体该 decorator 的执行（即返回 descriptor）就是在我们申明的地方
            decoratorArguments = Array.prototype.slice.call(arguments)
            return decorator
        }
    } as Function
}

export function quacksLikeADecorator(args: IArguments): boolean {
    return (
        ((args.length === 2 || args.length === 3) && typeof args[1] === "string") ||
        (args.length === 4 && args[3] === true)
    )
}
