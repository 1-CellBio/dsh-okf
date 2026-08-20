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
};

export function PageReader({ page, loading, error, empty, t }: PageReaderProps) {
  if (loading) {
    return <p className={css.empty}>{t("library.loading")}</p>;
  }
  if (error) {
    return <p className={css.error} role="alert">{error}</p>;
  }
  if (!page) {
    return <p className={css.empty}>{empty}</p>;
  }
  const source = stripLeadingTitle(page.body, page.title);
  return (
    <article className={css.reader} aria-label={page.title || page.id}>
      <h3 className={css.readerTitle}>{page.title || page.id}</h3>
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
