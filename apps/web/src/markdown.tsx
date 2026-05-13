import { Fragment, type ReactElement, type ReactNode } from "react";

export function MarkdownContent({
  content
}: {
  readonly content: string;
}): ReactElement {
  return <div className="message-content">{renderMarkdown(content)}</div>;
}

export function renderMarkdown(content: string): readonly ReactNode[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push(
        <pre key={`code-${blocks.length}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (/^#{1,3}\s+/.test(trimmed)) {
      const level = Math.min(3, trimmed.match(/^#+/)?.[0].length ?? 1);
      const headingContent = trimmed.replace(/^#{1,3}\s+/, "");

      if (level === 1) {
        blocks.push(<h3 key={`heading-${blocks.length}`}>{renderInline(headingContent, blocks.length)}</h3>);
      } else if (level === 2) {
        blocks.push(<h4 key={`heading-${blocks.length}`}>{renderInline(headingContent, blocks.length)}</h4>);
      } else {
        blocks.push(<h5 key={`heading-${blocks.length}`}>{renderInline(headingContent, blocks.length)}</h5>);
      }

      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];

      while (index < lines.length && /^>\s?/.test((lines[index] ?? "").trim())) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }

      blocks.push(
        <blockquote key={`quote-${blocks.length}`}>
          <p>{renderInline(quoteLines.join(" "), blocks.length)}</p>
        </blockquote>
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];

      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? "").trim())) {
        const itemContent = (lines[index] ?? "").trim().replace(/^[-*]\s+/, "");
        items.push(
          <li key={`ul-item-${blocks.length}-${items.length}`}>
            {renderInline(itemContent, `${blocks.length}-${items.length}`)}
          </li>
        );
        index += 1;
      }

      blocks.push(<ul key={`ul-${blocks.length}`}>{items}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: ReactNode[] = [];

      while (index < lines.length && /^\d+\.\s+/.test((lines[index] ?? "").trim())) {
        const itemContent = (lines[index] ?? "").trim().replace(/^\d+\.\s+/, "");
        items.push(
          <li key={`ol-item-${blocks.length}-${items.length}`}>
            {renderInline(itemContent, `${blocks.length}-${items.length}`)}
          </li>
        );
        index += 1;
      }

      blocks.push(<ol key={`ol-${blocks.length}`}>{items}</ol>);
      continue;
    }

    const paragraphLines: string[] = [];

    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !isMarkdownBlockStart((lines[index] ?? "").trim())
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }

    blocks.push(
      <p key={`paragraph-${blocks.length}`}>
        {renderInline(paragraphLines.join(" "), blocks.length)}
      </p>
    );
  }

  return blocks;
}

function renderInline(content: string, keyPrefix: string | number): readonly ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)/g;
  let lastIndex = 0;
  let match = pattern.exec(content);

  while (match) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }

    if (match[2] && match[3]) {
      parts.push(
        <a
          key={`link-${keyPrefix}-${parts.length}`}
          href={match[3]}
          target="_blank"
          rel="noreferrer"
        >
          {match[2]}
        </a>
      );
    } else if (match[5]) {
      parts.push(
        <code key={`code-${keyPrefix}-${parts.length}`}>{match[5]}</code>
      );
    } else if (match[7]) {
      parts.push(
        <strong key={`strong-${keyPrefix}-${parts.length}`}>
          {renderInline(match[7], `${keyPrefix}-${parts.length}`)}
        </strong>
      );
    }

    lastIndex = match.index + match[0].length;
    match = pattern.exec(content);
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0
    ? parts
    : [<Fragment key={`text-${keyPrefix}`}>{content}</Fragment>];
}

function isMarkdownBlockStart(value: string): boolean {
  return (
    value.startsWith("```") ||
    /^#{1,3}\s+/.test(value) ||
    /^>\s?/.test(value) ||
    /^[-*]\s+/.test(value) ||
    /^\d+\.\s+/.test(value)
  );
}
