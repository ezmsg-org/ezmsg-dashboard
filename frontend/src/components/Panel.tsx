import type { PropsWithChildren } from "react";

type PanelProps = PropsWithChildren<{
  title?: string;
  subtitle?: string;
}>;

export function Panel({ title, subtitle, children }: PanelProps) {
  const hasHeader = Boolean(title) || Boolean(subtitle);
  return (
    <section className={`panel ${hasHeader ? "" : "panel--headerless"}`.trim()}>
      {hasHeader ? (
        <header className="panel__header">
          {title ? <h2>{title}</h2> : null}
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
      ) : null}
      <div className="panel__body">{children}</div>
    </section>
  );
}
