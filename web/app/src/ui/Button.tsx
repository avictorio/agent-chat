import type { ButtonHTMLAttributes, Ref } from "react";

// The app's buttons (styles in ui/button.css and ui/late.css). Each renders
// a plain <button> and passes every other prop through unchanged. None adds
// a type: like the element, a button inside a form submits unless its type
// says otherwise, so pass type="button" where that matters.

type Native = ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };

export type ButtonProps = Native & {
  /** primary: the accent fill; quiet: no border or fill until hovered. */
  variant?: "primary" | "quiet";
  /** sm: the compact size used in rows, cards and strips. */
  size?: "sm";
  /** Danger-coloured text (a destructive action). */
  danger?: boolean;
  /** A square, icon-only button (.icon-btn); it needs an accessible name. */
  icon?: boolean;
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The .btn button. */
export function Button({ variant, size, danger, icon, className, ...rest }: ButtonProps) {
  return <button className={cx("btn", size, variant, danger && "danger", icon && "icon-btn", className)} {...rest} />;
}

/** An icon-only .btn: `label` is its accessible name (aria-label). */
export function IconButton({ label, ...rest }: Omit<ButtonProps, "icon" | "aria-label"> & { label: string }) {
  return <Button icon aria-label={label} {...rest} />;
}

/** A button that reads as an inline text link (.linkbtn), e.g. "remove". */
export function LinkButton({ className, ...rest }: Native) {
  return <button className={cx("linkbtn", className)} {...rest} />;
}
