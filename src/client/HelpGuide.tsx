import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Button,
  DisclosureRow,
  Pill,
  writeClipboard,
  IconArchiveOutline20,
  IconBranchOutline16,
  IconCheckOutline16,
  IconChecklistOutline14,
  IconCopyOutline16,
  IconDataOutline16,
  IconListPenOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { OkfHelp, OkfHelpExample, OkfSubpage } from "../help.ts";
import type { OkfLocaleKey } from "./locales.ts";
import css from "./HelpGuide.module.css";

const SUBPAGE_ICONS: Record<string, ReactNode> = {
  papers: <IconDataOutline16 />,
  graph: <IconBranchOutline16 />,
  review: <IconChecklistOutline14 />,
  coverage: <IconSearchOutline16 />,
  survey: <IconListPenOutline16 />,
  notes: <IconArchiveOutline20 />,
};

const CATEGORIES = ["A", "B", "C", "D", "E", "F", "G"] as const;

type CategoryId = (typeof CATEGORIES)[number] | "other";
type CategoryFilter = CategoryId | "all";
type Tab = "quickstart" | "examples";

const CATEGORY_LABEL: Record<CategoryId, OkfLocaleKey> = {
  A: "help.cat.A",
  B: "help.cat.B",
  C: "help.cat.C",
  D: "help.cat.D",
  E: "help.cat.E",
  F: "help.cat.F",
  G: "help.cat.G",
  other: "help.catOther",
};

const CATEGORY_CLASS: Record<CategoryId, string> = {
  A: css.catA,
  B: css.catB,
  C: css.catC,
  D: css.catD,
  E: css.catE,
  F: css.catF,
  G: css.catG,
  other: css.catOther,
};

function categoryOf(example: OkfHelpExample): CategoryId {
  const letter = example.id.trim().charAt(0).toUpperCase();
  return (CATEGORIES as readonly string[]).includes(letter) ? (letter as CategoryId) : "other";
}

/**
 * Equalize the height of every direct child of the container: measure each
 * child's natural height and pin the tallest one back on the container as a
 * CSS variable (min-height on children), so cards stay uniform across rows.
 */
function useEqualHeights<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const container = ref.current;
    if (container === null) {
      return;
    }
    const apply = (): void => {
      container.style.setProperty("--okf-card-h", "0px");
      let max = 0;
      for (const child of Array.from(container.children)) {
        max = Math.max(max, (child as HTMLElement).offsetHeight);
      }
      container.style.setProperty("--okf-card-h", `${max}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  return ref;
}

type HelpGuideProps = {
  help: OkfHelp;
  t: (key: OkfLocaleKey) => string;
};

type ExampleGroup = {
  id: CategoryId;
  items: OkfHelpExample[];
};

export function HelpGuide({ help, t }: HelpGuideProps) {
  const [tab, setTab] = useState<Tab>("quickstart");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const copyTimer = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const subpageGridRef = useEqualHeights<HTMLDivElement>();

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const copy = (id: string, text: string): void => {
    void writeClipboard(text);
    setCopied(id);
    if (copyTimer.current !== undefined) {
      window.clearTimeout(copyTimer.current);
    }
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
  };

  const toggle = (id: string): void => {
    setOpen((value) => ({ ...value, [id]: !value[id] }));
  };

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (example: OkfHelpExample): boolean => {
    if (!normalizedQuery) {
      return true;
    }
    return [example.id, example.ask, example.expect, example.fail]
      .join("\n")
      .toLowerCase()
      .includes(normalizedQuery);
  };

  const hasOther = help.examples.some((example) => categoryOf(example) === "other");
  const chipCategories: CategoryId[] = hasOther ? [...CATEGORIES, "other"] : [...CATEGORIES];
  const countOf = (cat: CategoryId): number =>
    help.examples.filter((example) => categoryOf(example) === cat).length;

  const groups: ExampleGroup[] = chipCategories
    .filter((cat) => category === "all" || category === cat)
    .map((cat) => ({
      id: cat,
      items: help.examples.filter((example) => categoryOf(example) === cat && matchesQuery(example)),
    }))
    .filter((group) => group.items.length > 0);

  const visibleIds = groups.flatMap((group) => group.items.map((item) => item.id));
  const anyVisibleOpen = visibleIds.some((id) => open[id] === true);
  const toggleAll = (): void => {
    setOpen(anyVisibleOpen ? {} : Object.fromEntries(visibleIds.map((id) => [id, true])));
  };

  return (
    <div className={css.guide}>
      <header className={css.hero}>
        <div className={css.heroTitleRow}>
          <Pill className={css.badge}>{t("help.badge")}</Pill>
          <h2 className={css.heroTitle}>{help.title}</h2>
        </div>
        <p className={css.lead}>{t("help.hint")}</p>
        <p className={css.intro}>{t("help.intro")}</p>
      </header>

      <div className={css.tabs} role="tablist" aria-label={t("help.title")}>
        <Pill
          role="tab"
          aria-selected={tab === "quickstart"}
          active={tab === "quickstart"}
          onClick={() => setTab("quickstart")}
        >
          {t("help.quickstart")}
        </Pill>
        <Pill
          role="tab"
          aria-selected={tab === "examples"}
          active={tab === "examples"}
          onClick={() => setTab("examples")}
        >
          {t("help.examples")}
        </Pill>
      </div>

      <div ref={panelRef} className={css.panel} role="tabpanel">
        {tab === "quickstart" ? (
          <>
            {help.prereq.length > 0 ? (
              <div className={css.section}>
                <h3 className={css.sectionTitle}>{t("help.before")}</h3>
                <div className={css.prereqCard}>
                  {help.prereq.map((item) => (
                    <div key={item.id} className={css.prereqRow}>
                      <Pill
                        className={css.prereqAsk}
                        title={t("help.copy")}
                        onClick={() => copy(`prereq:${item.id}`, item.ask)}
                      >
                        {item.ask}
                      </Pill>
                      <span className={css.prereqText}>{item.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className={css.section}>
              <h3 className={css.sectionTitle}>{t("help.askWith")}</h3>
              <div className={css.chipRow}>
                {help.askWith.map((ask) => (
                  <Pill key={ask} title={t("help.copy")} onClick={() => copy(`ask:${ask}`, ask)} className={css.chip}>
                    {ask}
                  </Pill>
                ))}
              </div>
            </div>

            <div className={css.section}>
              <h3 className={css.sectionTitle}>{t("help.subpages")}</h3>
              <div ref={subpageGridRef} className={css.subpageGrid}>
                {help.subpages.map((subpage) => (
                  <SubpageCard key={subpage.id} subpage={subpage} />
                ))}
              </div>
            </div>

            <div className={css.section}>
              <h3 className={css.sectionTitle}>{t("help.tools")}</h3>
              <ol className={css.steps}>
                {help.toolSteps.map((step, index) => (
                  <li key={step.id} className={css.step}>
                    <span className={css.stepNum}>{index + 1}</span>
                    <span className={css.stepText}>{step.text}</span>
                    <code className={css.stepTool}>{step.tool}</code>
                  </li>
                ))}
              </ol>
            </div>
          </>
        ) : (
          <div className={css.section}>
            <h3 className={css.sectionTitle}>{t("help.examples")}</h3>
            <p className={css.sectionHint}>{t("help.examplesHint")}</p>
            <div className={css.filterBar}>
              <input
                className={css.filterInput}
                value={query}
                placeholder={t("help.filterPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className={css.filterChips}>
                <Pill active={category === "all"} onClick={() => setCategory("all")}>
                  {t("help.all")} ({help.examples.length})
                </Pill>
                {chipCategories.map((cat) => (
                  <Pill
                    key={cat}
                    active={category === cat}
                    onClick={() => setCategory(category === cat ? "all" : cat)}
                  >
                    {cat === "other" ? "" : `${cat} · `}
                    {t(CATEGORY_LABEL[cat])} ({countOf(cat)})
                  </Pill>
                ))}
              </div>
              {visibleIds.length > 0 ? (
                <Button size="sm" variant="outline" onClick={toggleAll}>
                  {anyVisibleOpen ? t("help.collapseAll") : t("help.expandAll")}
                </Button>
              ) : null}
            </div>
            {groups.length === 0 ? (
              <p className={css.noMatch}>{t("help.noMatch")}</p>
            ) : (
              <div className={css.examples}>
                {groups.map((group) => (
                  <div key={group.id} className={css.group}>
                    <div className={css.groupHeader}>
                      <span className={`${css.groupDot} ${CATEGORY_CLASS[group.id]}`} aria-hidden />
                      <span className={css.groupName}>
                        {group.id === "other" ? "" : `${group.id} · `}
                        {t(CATEGORY_LABEL[group.id])}
                      </span>
                      <span className={css.groupCount}>{group.items.length}</span>
                    </div>
                    {group.items.map((example) => (
                      <DisclosureRow
                        key={example.id}
                        icon={<span className={`${css.exampleId} ${CATEGORY_CLASS[group.id]}`}>{example.id}</span>}
                        title={`${example.id} · ${example.expect}`}
                        titleClassName={css.exampleTitle}
                        open={open[example.id] === true}
                        expandable
                        onToggle={() => toggle(example.id)}
                      >
                        <div className={css.exampleBody}>
                          <div className={css.exampleAsk}>
                            <span className={css.exampleLabel}>{t("help.ask")}</span>
                            <p className={css.exampleAskText}>{example.ask}</p>
                          </div>
                          <div className={css.exampleRow}>
                            <Pill className={css.expectPill}>{t("help.expect")}</Pill>
                            <span className={css.exampleRowText}>{example.expect}</span>
                          </div>
                          <div className={css.exampleRow}>
                            <Pill className={css.failPill}>{t("help.fail")}</Pill>
                            <span className={css.exampleRowText}>{example.fail}</span>
                          </div>
                          <div className={css.exampleActions}>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={copied === example.id ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
                              onClick={() => copy(example.id, example.ask)}
                            >
                              {copied === example.id ? t("help.copied") : t("help.copy")}
                            </Button>
                          </div>
                        </div>
                      </DisclosureRow>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <aside className={css.note} role="note">
        <IconWarningOutline16 />
        <span>{t("help.note")}</span>
      </aside>
    </div>
  );
}

function SubpageCard({ subpage }: { subpage: OkfSubpage }) {
  return (
    <div className={css.subpageCard}>
      <span className={css.subpageIcon}>{SUBPAGE_ICONS[subpage.id]}</span>
      <div className={css.subpageText}>
        <span className={css.subpageName}>{subpage.name}</span>
        <span className={css.subpageDesc}>{subpage.description}</span>
      </div>
    </div>
  );
}
