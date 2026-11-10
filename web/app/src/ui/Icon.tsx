import type { ReactNode } from "react";

// The one stroke-icon component: a 24x24 svg with the given paths
// (and optional extra raw children, e.g. a <circle>).
export function Icon({ d, extra }: { d: string[]; extra?: ReactNode }) {
  return (
    <svg className="i" viewBox="0 0 24 24">
      {extra}
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}
