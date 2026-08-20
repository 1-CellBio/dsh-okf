import type { KeyboardEvent, ReactNode } from "react";
import { useState } from "react";
import css from "./OkfToolCard.module.css";

export type OkfCardState = "running" | "ok" | "error" | "stopped";

export type OkfToolCardProps = {
  tool: string;
  state: OkfCardState;
  title: string;
  summary: string;
  status?: string | null;
  inspectLabel: string;
  inspect?: () => void;
  children?: ReactNode;
};

export function OkfToolCard({
  tool,
  state,
  title,
  summary,
  status,
  inspectLabel,
  inspect,
  children,
}: OkfToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const expandable = children !== undefined && children !== null && state !== "running";
  const open = expanded && expandable;
  const toggle = (): void => {
    if (!expandable) {
      return;
    }
    setExpanded((value) => !value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    toggle();
  };
  return (
    <div className={css.card} data-tool={tool} data-state={state}>
      <div
        className={css.row}
        data-expandable={expandable || undefined}
        {...(expandable
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-expanded": open,
              onClick: toggle,
              onKeyDown,
            }
          : {})}
      >
        <span className={css.leading} data-open={open || undefined} />
        {status ? <span className={css.visuallyHidden}>{status}</span> : null}
        <span className={css.title}>{title}</span>
        <span className={css.separator} aria-hidden />
        <span className={state === "error" ? `${css.summary} ${css.errorSummary}` : css.summary}>
          {summary}
        </span>
      </div>
      {open ? (
        <div className={css.bodyWrap}>
          {children}
          {inspect !== undefined ? (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              {inspectLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
