/**
 * 客户端 bundle 的最小类型声明。
 *
 * 客户端产物在浏览器里运行，依赖由宿主的模块表提供（`require("react")` 等），
 * 本包不安装 React。这里只声明用到的那一小部分，避免为类型引入构建期依赖。
 * 若将来客户端用到的 React 能力变多，再考虑把 `@types/react` 加进 devDependencies。
 */

declare module 'react' {
  export interface MutableRefObject<T> {
    current: T
  }

  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T
  export function useRef<T>(initial: T): MutableRefObject<T>
}

declare module 'react/jsx-runtime' {
  /** 宿主模块表里的 jsx 工厂；返回值是不透明的 React 元素。 */
  export function jsx(type: unknown, props: Record<string, unknown> | null, key?: string): unknown
  export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: string): unknown
  export const Fragment: unknown
}

/**
 * 宿主共享模块表里的 UI 原语。
 *
 * 本包不安装该依赖（它是宿主产物的一部分，经裸模块名从模块表取），所以只声明
 * 实际用到的三个组件。props 一律 `Record<string, unknown>`：这些组件的完整契约
 * 由宿主维护，客户端多声明一遍只会漂移；调用点传的是普通对象，交给
 * `jsx(type, props)` 处理即可。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export function Switch(props: Record<string, unknown>): unknown
  export function Input(props: Record<string, unknown>): unknown
  export function Button(props: Record<string, unknown>): unknown
}

// 浏览器全局：客户端编译不开 DOM lib（避免把整套 DOM 类型带进构建），只声明用到的部分。
declare const navigator: {
  readonly clipboard: { writeText(text: string): Promise<void> }
}

declare const window: {
  /** 浏览器返回数字句柄；声明成 number 以免调用点再写 `as`。 */
  setTimeout(handler: () => void, timeout: number): number
  clearTimeout(handle: number): void
}
