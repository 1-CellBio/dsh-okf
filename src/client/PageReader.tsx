import type { ReactNode } from "react";
import { MarkdownView } from "./MarkdownView.tsx";
import { stripLeadingTitle } from "./markdown.ts";
import type { OkfLocaleKey } from "./locales.ts";
import type { WorkbenchPage } from "./organize-model.ts";
import css from "./GraphView.module.css";

type PageReaderProps = {
  page: WorkbenchPage | null;
  loading: boolean;
  error: string | null;
  empty: string;
  t: (key: OkfLocaleKey) => string;
  onClose?: () => void;
  closeLabel?: string;
  actions?: ReactNode;
  banner?: ReactNode;
  previewLabel?: string;
};

export function PageReader({
  page,
  loading,
  error,
  empty,
  t,
  onClose,
  closeLabel,
  actions,
  banner,
  previewLabel,
}: PageReaderProps) {
  const close = onClose ? (
    <button type="button" className={css.readerClose} onClick={onClose} aria-label={closeLabel ?? t("review.close")}>
      ×
    </button>
  ) : null;

  if (loading) {
    return (
      <div className={css.reader}>
        <div className={css.readerBar}>{close}</div>
        {actions}
        <p className={css.empty}>{t("library.loading")}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={css.reader}>
        <div className={css.readerBar}>{close}</div>
        {actions}
        <p className={css.error} role="alert">{error}</p>
      </div>
    );
  }
  if (!page) {
    if (!onClose && !actions) {
      return <p className={css.empty}>{empty}</p>;
    }
    return (
      <div className={css.reader}>
        <div className={css.readerBar}>{close}</div>
        {banner}
        {actions}
        <p className={css.empty}>{empty}</p>
      </div>
    );
  }
  const source = stripLeadingTitle(page.body, page.title);
  return (
    <article className={css.reader} aria-label={page.title || page.id}>
      <div className={css.readerBar}>
        <h3 className={css.readerTitle}>{page.title || page.id}</h3>
        {close}
      </div>
      {banner}
      {actions}
      {previewLabel ? <p className={css.reviewSection}>{previewLabel}</p> : null}
      <p className={css.readerMeta}>
        <span className={css.muted}>{page.path}</span>
        {page.status ? <span className={css.status}>{page.status}</span> : null}
        {page.truncated ? <span className={css.muted}>{t("page.truncated")}</span> : null}
      </p>
      {source ? (
        <MarkdownView source={source} />
      ) : (
        <p className={css.empty}>{t("page.emptyBody")}</p>
      )}
    </article>
  );
}
