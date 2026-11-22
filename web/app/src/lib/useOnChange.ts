import { useLayoutEffect, useRef } from "react";

/** Calls fn after the first commit and after every commit in which any of
 *  the inputs changed (compared by identity, like a dependency list). For
 *  work keyed on values the work itself does not read - typically telling
 *  a frame loop under frameloop="demand" that its inputs moved
 *  (`settled.current = false`) - which an effect would have to list as
 *  dependencies it never uses. */
export function useOnChange(inputs: readonly unknown[], fn: () => void): void {
  const last = useRef<readonly unknown[] | null>(null);
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = inputs;
    if (prev && prev.length === inputs.length && prev.every((v, i) => Object.is(v, inputs[i]))) return;
    fn();
  });
}
