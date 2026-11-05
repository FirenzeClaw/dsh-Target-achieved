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

// 浏览器全局：客户端编译不开 DOM lib（避免把整套 DOM 类型带进构建），只声明用到的部分。
declare const navigator: {
  readonly clipboard: { writeText(text: string): Promise<void> }
}

declare const window: {
  setTimeout(handler: () => void, timeout: number): unknown
}
