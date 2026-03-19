import type { PropsWithChildren } from "react";

type PanelProps = PropsWithChildren<{
  title: string;
  subtitle: string;
}>;

export function Panel({ title, subtitle, children }: PanelProps) {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
