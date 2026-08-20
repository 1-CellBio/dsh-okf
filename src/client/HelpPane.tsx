import { okfHelp } from "../help.ts";
import { HelpGuide } from "./HelpGuide.tsx";
import type { OkfLocaleKey } from "./locales.ts";
import css from "./GraphView.module.css";

type HelpPaneProps = {
  t: (key: OkfLocaleKey) => string;
};

export function HelpPane({ t }: HelpPaneProps) {
  return (
    <section className={css.pane} aria-label={t("help.title")}>
      <HelpGuide help={okfHelp()} t={t} />
    </section>
  );
}
