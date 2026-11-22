import type { DialogHTMLAttributes, MouseEvent, Ref } from "react";

// The app's modal card: a native <dialog> with the .av-dlg look. Its owner
// opens it with showModal() and closes it with close(); Escape closes it
// natively. closeOnBackdrop also closes it on a click outside the
// card (the backdrop is the dialog element itself).
export type DialogProps = DialogHTMLAttributes<HTMLDialogElement> & {
  ref?: Ref<HTMLDialogElement>;
  closeOnBackdrop?: boolean;
};

export function Dialog({ className, closeOnBackdrop, onClick, ...rest }: DialogProps) {
  const click = closeOnBackdrop
    ? (e: MouseEvent<HTMLDialogElement>) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
        onClick?.(e);
      }
    : onClick;
  return <dialog className={className ? "av-dlg " + className : "av-dlg"} onClick={click} {...rest} />;
}
