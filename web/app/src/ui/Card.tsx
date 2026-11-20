import type { HTMLAttributes } from "react";

// A card and its parts (styles in features/board/board.css). Each is the
// plain <div> with its class; className adds to it. Cards that are forms
// (.card.add) or <details> keep their own element and class.

type Div = HTMLAttributes<HTMLDivElement>;
const join = (base: string, extra?: string) => (extra ? base + " " + extra : base);

export function Card({ className, ...rest }: Div) {
  return <div className={join("card", className)} {...rest} />;
}
export function CardTitle({ className, ...rest }: Div) {
  return <div className={join("card-title", className)} {...rest} />;
}
export function CardMeta({ className, ...rest }: Div) {
  return <div className={join("card-meta", className)} {...rest} />;
}
export function CardText({ className, ...rest }: Div) {
  return <div className={join("card-text", className)} {...rest} />;
}
export function CardActions({ className, ...rest }: Div) {
  return <div className={join("card-actions", className)} {...rest} />;
}
