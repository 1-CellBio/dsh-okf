import { createElement, useMemo, type ReactNode } from "react";
import { parseInline, parseMarkdownBlocks, type MdInline } from "./markdown-blocks.ts";
import css from "./GraphView.module.css";

type MarkdownViewProps = {
  source: string;
};

export function MarkdownView({ source }: MarkdownViewProps) {
  // Memoized: this component sits inside chat rows whose siblings re-render
  // during streaming, and re-parsing a large document on every pass was a
  // measurable cost.
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source]);
  if (!source.trim()) {
    return null;
  }
  return (
    <div className={css.markdown}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return createElement(`h${block.level}`, { key: index }, ...inline(block.text));
        }
        if (block.type === "paragraph") {
          return <p key={index}>{inline(block.text)}</p>;
        }
        if (block.type === "quote") {
          return <blockquote key={index}>{inline(block.text)}</blockquote>;
        }
        if (block.type === "code") {
          return <pre key={index}><code>{block.text}</code></pre>;
        }
        if (block.type === "hr") {
          return <hr key={index} />;
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <div key={index} className={css.mdTableWrap}>
            <table>
              <thead>
                <tr>
                  {block.headers.map((cell, cellIndex) => (
                    <th key={cellIndex}>{inline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{inline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return parseInline(text).map((part, index) => renderInline(part, index));
}

function renderInline(part: MdInline, key: number): ReactNode {
  if (part.type === "text") {
    return <span key={key}>{part.text}</span>;
  }
  if (part.type === "strong") {
    return <strong key={key}>{part.text}</strong>;
  }
  if (part.type === "em") {
    return <em key={key}>{part.text}</em>;
  }
  if (part.type === "code") {
    return <code key={key}>{part.text}</code>;
  }
  if (part.external) {
    return (
      <a key={key} href={part.href} target="_blank" rel="noreferrer">
        {part.text}
      </a>
    );
  }
  if (part.conceptId) {
    return (
      <span key={key} className={css.mdLink} title={part.conceptId}>
        {part.text}
      </span>
    );
  }
  return <span key={key}>{part.text}</span>;
}
