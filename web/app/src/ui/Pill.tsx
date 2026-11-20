import type { HTMLAttributes } from "react";

// A small rounded status label (.pill, styles in features/board/board.css):
// accent by default; warn, muted or danger for the other states.
export type PillTone = "warn" | "muted" | "danger";

export function Pill({ tone, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: PillTone }) {
  return <span className={["pill", tone, className].filter(Boolean).join(" ")} {...rest} />;
}
