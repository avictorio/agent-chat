import type { ButtonHTMLAttributes, HTMLAttributes, Ref } from "react";

// Navigation pieces of the sidebar (styles in features/room/sidebar.css):
// a tab that marks the current view, and the count beside a tab's label.

/** A sidebar tab (.tab): a button that marks itself aria-current="page" when it is the current view. */
export function NavTab({
  current,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { current?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      className={className ? "tab " + className : "tab"}
      aria-current={current ? "page" : undefined}
      {...rest}
    />
  );
}

/** The count beside a tab's label (.count); alert gives it the accent pill. */
export function Count({ alert, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { alert?: boolean }) {
  return <span className={["count", alert && "alert", className].filter(Boolean).join(" ")} {...rest} />;
}
