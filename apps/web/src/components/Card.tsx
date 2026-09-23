import type { ReactNode } from "react";

export function Card({
  title,
  children,
}: {
  readonly title?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="arbor-card">
      {title === undefined ? null : (
        <header className="arbor-card-header">
          <h2 className="arbor-card-title">{title}</h2>
        </header>
      )}
      <div className="arbor-card-body">{children}</div>
    </section>
  );
}
