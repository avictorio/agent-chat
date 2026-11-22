import { useState } from "react";

/** The value as it was when its key last changed: a new object that
 *  means the same thing (same key) keeps the earlier identity, so the
 *  memos and effects downstream of it do not rebuild. The key is a
 *  signature of whatever matters in the value. State adjusted during
 *  render, React's pattern for "derive from the previous render", so
 *  there is no ref read during render and no memo keyed on a value it
 *  does not use. */
export function useStable<T>(value: T, key: string): T {
  const [kept, setKept] = useState({ key, value });
  if (kept.key !== key) {
    setKept({ key, value });
    return value;
  }
  return kept.value;
}
