import type { HTMLAttributes, ReactNode } from "react";

// A full-width page view (styles in features/board/board.css): the
// scrolling .view section, then .page and its centred .page-inner column.
// The board's pages head it with PageHead; the home page's views use an
// h1.page-title and p.lede inside it instead.

/** A page view: section.view > div.page > div.page-inner > children. */
export function Page({ children, className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={className ? "view " + className : "view"} {...rest}>
      <div className="page">
        <div className="page-inner">{children}</div>
      </div>
    </section>
  );
}

/** A board page's head: its title and a line on what the page is for. */
export function PageHead({ title, intro, introId }: { title: ReactNode; intro: ReactNode; introId?: string }) {
  return (
    <header className="page-head">
      <h2>{title}</h2>
      <p id={introId}>{intro}</p>
    </header>
  );
}
