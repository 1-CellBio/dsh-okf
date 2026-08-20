import { useMemo } from "react";
import { MarkdownView } from "./MarkdownView.tsx";
import { HelpGuide } from "./HelpGuide.tsx";
import { OkfToolCard } from "./OkfToolCard.tsx";
import type { OkfLocaleKey } from "./locales.ts";
import { lifecycleOf, parseObject, resultTextOf, type KgToolBlock } from "./parse.ts";
import type { OkfHelp, OkfHelpExample, OkfPrereq, OkfSubpage, OkfToolStep } from "../help.ts";
import css from "./GraphView.module.css";

export type HelpRowProps = {
  block: KgToolBlock;
  inspect?: () => void;
  t: (key: OkfLocaleKey) => string;
};

export function HelpRow({ block, inspect, t }: HelpRowProps) {
  const state = lifecycleOf(block);
  // The tool output can be hundreds of KB and the surrounding chat row
  // re-renders on every streaming token; memoize the JSON.parse + shaping.
  const shaped = useMemo(() => {
    const output = resultTextOf(block);
    const body = output ? parseObject(output) : null;
    return {
      title: typeof body?.title === "string" ? body.title : "",
      help: toOkfHelp(body),
    };
  }, [block]);
  const title = shaped.title || t("help.title");
  const help = shaped.help;
  const markdown = help.markdown;
  const hasStructured = help.examples.length > 0 || help.subpages.length > 0 || help.toolSteps.length > 0;
  return (
    <OkfToolCard
      tool="okf_help"
      state={state}
      title={t("help.title")}
      summary={title}
      inspectLabel={t("row.inspect")}
      inspect={inspect}
    >
      {hasStructured ? (
        <HelpGuide help={help} t={t} />
      ) : markdown ? (
        <div className={css.helpBody}>
          <MarkdownView source={markdown} />
        </div>
      ) : (
        <p className={css.empty}>{t("help.empty")}</p>
      )}
    </OkfToolCard>
  );
}

function toOkfHelp(body: Record<string, unknown> | null): OkfHelp {
  if (body === null) {
    return { title: "", askWith: [], markdown: "", examples: [], subpages: [], toolSteps: [], prereq: [] };
  }
  return {
    title: typeof body.title === "string" ? body.title : "",
    askWith: asStringArray(body.askWith),
    markdown: typeof body.markdown === "string" ? body.markdown : "",
    examples: asExamples(body.examples),
    subpages: asSubpages(body.subpages),
    toolSteps: asToolSteps(body.toolSteps),
    prereq: asPrereqs(body.prereq),
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function asExamples(value: unknown): OkfHelpExample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: OkfHelpExample[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const ask = typeof record.ask === "string" ? record.ask : "";
    const expect = typeof record.expect === "string" ? record.expect : "";
    const fail = typeof record.fail === "string" ? record.fail : "";
    if (id && ask) {
      items.push({ id, ask, expect, fail });
    }
  }
  return items;
}

function asSubpages(value: unknown): OkfSubpage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: OkfSubpage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    const description = typeof record.description === "string" ? record.description : "";
    if (id && name) {
      items.push({ id, name, description });
    }
  }
  return items;
}

function asToolSteps(value: unknown): OkfToolStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: OkfToolStep[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const tool = typeof record.tool === "string" ? record.tool : "";
    const text = typeof record.text === "string" ? record.text : "";
    if (id && text) {
      items.push({ id, tool, text });
    }
  }
  return items;
}

function asPrereqs(value: unknown): OkfPrereq[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: OkfPrereq[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const ask = typeof record.ask === "string" ? record.ask : "";
    const text = typeof record.text === "string" ? record.text : "";
    if (id && ask) {
      items.push({ id, ask, text });
    }
  }
  return items;
}
