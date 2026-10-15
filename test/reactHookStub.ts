export function useRef<T>(value: T) { return { current: value } }
export function useEffect(effect: () => void | (() => void)) { effect() }
