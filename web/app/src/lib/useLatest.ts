import { useLayoutEffect, useRef } from "react";

/* A ref that holds the latest value of something, for callbacks and
   effects that must read it without re-running when it changes (a
   handler bound once, a timer, a store created once). It is updated after
   each render, in a layout effect - never during render, which React
   forbids (the react/refs lint rule) - so render code reads the value
   itself, never the ref. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
