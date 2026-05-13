import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/markdown.js";

describe("markdown content", () => {
  it("renders paragraphs, emphasis, inline code, links, and lists", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={[
          "## Results",
          "",
          "**Revenue** is up and `select *` is blocked.",
          "",
          "- first item",
          "- second item",
          "",
          "See [docs](https://example.com)."
        ].join("\n")}
      />
    );

    expect(html).toContain("<h4>");
    expect(html).toContain("<strong>Revenue</strong>");
    expect(html).toContain("<code>select *");
    expect(html).toContain("<ul>");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders fenced code blocks and blockquotes", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={[
          "> safe query only",
          "",
          "```sql",
          "select id from Tenant limit 20",
          "```"
        ].join("\n")}
      />
    );

    expect(html).toContain("<blockquote>");
    expect(html).toContain("<pre>");
    expect(html).toContain("select id from Tenant limit 20");
  });
});
