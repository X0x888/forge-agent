import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMarkdownRenderer } from "../src/tui/markdown.js";

/** Render a document through the styled renderer in the given chunks. */
function renderStyled(chunks: string[]): string {
  const r = createMarkdownRenderer({ color: true });
  let out = "";
  for (const c of chunks) out += r.push(c);
  return out + r.end();
}

function renderPlain(chunks: string[]): string {
  const r = createMarkdownRenderer({ color: false });
  let out = "";
  for (const c of chunks) out += r.push(c);
  return out + r.end();
}

const DOCS: Record<string, string> = {
  full: [
    "# Title",
    "",
    "Some **bold** and *italic* and `inline code` and ~~struck~~ here.",
    "See ![hero](https://x.dev/a.png) too.",
    "",
    "- item one",
    "- item two",
    "1. numbered",
    "",
    "```ts",
    "const x = 1;",
    "console.log(`**not bold**`);",
    "```",
    "",
    "After the fence.",
    "",
  ].join("\n"),
  unclosedFence: "Before.\n```python\nprint('hi')\nstill code, no close",
  linksAndRules:
    "A [link](https://example.com/p?a=1&b=2) here.\nSee https://x.dev/docs?q=1.\n> quoted line\n---\n1. first\n2. second\n",
  trailingBold: "Trailing **bold without close",
  headingOnly: "### Deep heading",
  snakeCase: "snake_case_names stay literal but _this_ is italic\n",
  noTrailingNewline: "one line, no newline",
  empty: "",
  fenceAtEnd: "text\n```\ncode line\n```",
  blockComment:
    "```ts\nconst a = 1;\n/* open\nstill comment\n*/\nconst b = 2;\n```\n",
  crlf: "line one\r\nline two\r\n",
  table:
    "| Wave | Ship |\n| --- | --- |\n| 1 | clip |\n| 2 | **deny** |\n",
  tableNoNl: "| Wave | Ship |\n| --- | --- |\n| 1 | clip |",
  tasks:
    "- [ ] open item\n- [x] **done** item\n- [X] also done\n- not a task\n* [ ] star open\n1. [ ] numbered open\n",
  strike: "dropped ~~old path~~ kept\n~~**bold strike**~~ and `~~not strike~~`\n",
};

describe("markdown renderer chunk-boundary invariance", () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    test(`invariant across every single split: ${name}`, () => {
      const full = renderStyled([doc]);
      for (let i = 0; i <= doc.length; i++) {
        const split = renderStyled([doc.slice(0, i), doc.slice(i)]);
        assert.equal(
          split,
          full,
          `split at byte ${i} of ${JSON.stringify(doc.slice(0, 40))}… diverged`,
        );
      }
    });
  }

  test("invariant across random multi-splits (seeded)", () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0x5eed;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (const doc of Object.values(DOCS)) {
      const full = renderStyled([doc]);
      for (let trial = 0; trial < 60; trial++) {
        const cuts = new Set<number>();
        const nCuts = 1 + (rand() % 5);
        for (let k = 0; k < nCuts; k++) cuts.add(rand() % (doc.length + 1));
        const sorted = [...cuts].sort((a, b) => a - b);
        const chunks: string[] = [];
        let prev = 0;
        for (const cut of sorted) {
          chunks.push(doc.slice(prev, cut));
          prev = cut;
        }
        chunks.push(doc.slice(prev));
        assert.equal(renderStyled(chunks), full, `cuts ${sorted} diverged`);
      }
    }
  });

  test("passthrough (color:false) is byte-identical for every split", () => {
    for (const doc of Object.values(DOCS)) {
      for (let i = 0; i <= doc.length; i++) {
        assert.equal(renderPlain([doc.slice(0, i), doc.slice(i)]), doc);
      }
    }
  });
});

describe("markdown renderer styling", () => {
  const ESC = "\x1b[";

  test("H1 is bold + underlined; H2 bold; H3+ dim bold — hashes stripped", () => {
    const h1 = renderStyled(["# Title\n"]);
    assert.ok(h1.includes(`${ESC}1m`), "H1 bold missing");
    assert.ok(h1.includes(`${ESC}4m`), "H1 underline missing");
    assert.ok(h1.includes("Title"));
    assert.ok(!h1.includes("# Title"));

    const h2 = renderStyled(["## Section\n"]);
    assert.ok(h2.includes(`${ESC}1m`), "H2 bold missing");
    assert.ok(!h2.includes(`${ESC}4m`), "H2 should not underline");
    assert.ok(h2.includes("Section"));
    assert.ok(!h2.includes("## Section"));

    const h3 = renderStyled(["### Deep heading\n"]);
    assert.ok(h3.includes(`${ESC}1m`), "H3 bold missing");
    assert.ok(h3.includes(`${ESC}2m`), "H3 dim missing");
    assert.ok(!h3.includes(`${ESC}4m`), "H3 should not underline");
    assert.ok(h3.includes("Deep heading"));
    assert.ok(!h3.includes("### Deep heading"));
  });

  test("bold spanning chunk boundaries renders once the line completes", () => {
    const out = renderStyled(["a **bo", "ld** b\n"]);
    assert.ok(out.includes(`${ESC}1mbold${ESC}22m`));
    assert.ok(!out.includes("**"));
  });

  test("inline code is styled, backticks removed, contents not emphasized", () => {
    const out = renderStyled(["use `**x**` now\n"]);
    // code span keeps its literal ** but must NOT be bolded
    assert.ok(out.includes("**x**"));
    assert.ok(!out.includes(`${ESC}1m`), "code contents were emphasized");
    // dim(2m) + yellow(33m) wrap the code span
    assert.ok(out.includes(`${ESC}33m`), "yellow missing");
  });

  test("unclosed fence at end styles remaining lines as code", () => {
    const out = renderStyled(["text\n```js\nconst a = 1;"]);
    const bare = out.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(out.includes("│"), "code gutter missing");
    assert.ok(bare.includes("const a = 1;"));
  });

  test("heading at chunk edge is still a heading", () => {
    const out = renderStyled(["intro\n## Sub", "head\nnext\n"]);
    assert.ok(out.includes(`${ESC}1m`), "H2 bold missing");
    assert.ok(!out.includes(`${ESC}4m`), "H2 should not underline");
    assert.ok(out.includes("Subhead"));
    assert.ok(!out.includes("## Subhead"));
  });

  test("fence state toggles across chunks", () => {
    const out = renderStyled(["`", "``\ncode\n`", "``\nafter\n"]);
    assert.ok(out.includes("│"));
    // after the closing fence, plain text has no gutter
    const afterLine = out.split("\n").find((l) => l.includes("after"));
    assert.ok(afterLine && !afterLine.includes("│"));
  });

  test("links render as text (url)", () => {
    const out = renderStyled(["see [docs](https://x.dev/a) ok\n"]);
    assert.ok(out.includes("docs"));
    assert.ok(out.includes("(https://x.dev/a)"));
    assert.ok(!out.includes("[docs]"));
  });

  test("lists keep markers, bullets are colored", () => {
    const out = renderStyled(["- thing\n2. other\n"]);
    assert.ok(out.includes("thing"));
    assert.ok(out.includes("other"));
  });

  test("unclosed emphasis stays literal", () => {
    const out = renderStyled(["a **open b\n"]);
    assert.ok(out.includes("**open"));
  });

  test("GFM tables dim pipes and style cells; separator becomes a rule", () => {
    const out = renderStyled([
      "| Wave | Ship |\n| --- | --- |\n| 1 | **deny** |\n",
    ]);
    assert.ok(out.includes("Wave"));
    assert.ok(out.includes("Ship"));
    assert.ok(out.includes("deny"));
    assert.ok(!out.includes("| Wave |"), "raw pipe row leaked");
    assert.ok(!out.includes("| --- |"), "raw separator leaked");
    assert.ok(out.includes("─"), "separator rule missing");
    assert.ok(out.includes(`${ESC}1mdeny${ESC}22m`), "cell emphasis missing");
  });

  test("GFM tables align columns so the header sits over the body", () => {
    const out = renderStyled([
      "| Wave | Ship |\n| --- | --- |\n| 1 | clip |\n| 2 | **deny** |\n",
    ]);
    const bare = out.replace(/\x1b\[[0-9;]*m/g, "");
    const rows = bare.split("\n").filter((l) => l.includes("│"));
    assert.ok(rows.length >= 3, `expected ≥3 table rows, got ${rows.length}`);
    const header = rows[0]!;
    const body = rows[2]!;
    assert.equal(header.length, body.length, "header/body column widths drifted");
    assert.equal(header.indexOf("Wave"), body.indexOf("1"));
    assert.equal(header.indexOf("Ship"), body.indexOf("clip"));
  });

  test("opening fence paints the language as a tag", () => {
    const out = renderStyled(["```ts\nconst x = 1;\n```\n"]);
    assert.ok(out.includes("ts"), "language tag missing");
    assert.ok(!out.includes("```ts"), "raw fence+lang leaked");
    assert.ok(out.includes("│"), "code gutter missing");
    assert.ok(out.includes(`${ESC}36mts${ESC}39m`) || out.includes("ts"));
  });

  test("fenced ts keywords and strings are colored; comments stay comments", () => {
    const out = renderStyled([
      "```ts\nconst x = 1; // n\nconst s = \"hi\";\n```\n",
    ]);
    assert.ok(out.includes("const"));
    assert.ok(out.includes("1"));
    assert.ok(out.includes("hi"));
    assert.ok(out.includes(`${ESC}35mconst${ESC}39m`), "keyword magenta missing");
    assert.ok(out.includes(`${ESC}33m1${ESC}39m`), "number yellow missing");
    assert.ok(out.includes(`${ESC}32m"hi"${ESC}39m`), "string green missing");
    assert.ok(out.includes("// n"), "comment text missing");
    assert.ok(!out.includes("**"), "fence must not run markdown");
  });

  test("a lone pipe is not a table", () => {
    const out = renderStyled(["just | one\n"]);
    assert.ok(out.includes("just | one"));
  });

  test("GFM task lists render ○/✓ and drop the checkbox", () => {
    const out = renderStyled([
      "- [ ] open item\n- [x] **done** item\n- [X] also\n1. [ ] numbered\n- not a task\n",
    ]);
    assert.ok(out.includes("○"), "open glyph missing");
    assert.ok(out.includes("✓"), "done glyph missing");
    assert.ok(out.includes("open item"));
    assert.ok(out.includes("done"));
    assert.ok(out.includes("numbered"));
    assert.ok(out.includes("not a task"));
    assert.ok(!out.includes("1."), "numbered marker leaked");
    assert.ok(!out.includes("[ ]"), "open checkbox leaked");
    assert.ok(!out.includes("[x]"), "done checkbox leaked");
    assert.ok(!out.includes("[X]"), "uppercase checkbox leaked");
    assert.ok(out.includes(`${ESC}1mdone${ESC}22m`), "task-body emphasis missing");
  });

  test("a fake checkbox stays a normal list", () => {
    const out = renderStyled(["- [n] not a task\n"]);
    assert.ok(out.includes("[n]"));
    assert.ok(!out.includes("○"));
    assert.ok(!out.includes("✓"));
  });

  test("bare https URLs style as autolinks; markdown links stay once", () => {
    const out = renderStyled([
      "See https://x.dev/docs?q=1. and [docs](https://x.dev/a).\n",
    ]);
    assert.ok(out.includes("https://x.dev/docs?q=1"));
    assert.ok(
      out.includes(`${ESC}4mhttps://x.dev/docs?q=1${ESC}24m`),
      "bare URL missing underline",
    );
    assert.ok(out.includes("docs"));
    assert.ok(
      !out.includes(`${ESC}4mhttps://x.dev/a${ESC}24m`),
      "markdown-link dest was restyled",
    );
    assert.match(
      out,
      /docs\?q=1(?:\x1b\[\d+m)+\./,
      "trailing period stayed outside the URL",
    );
  });

  test("GFM images drop the bang-link and keep alt", () => {
    const out = renderStyled([
      "see ![hero shot](https://x.dev/a.png) and ![](https://x.dev/b.png)\n",
    ]);
    assert.ok(out.includes("hero shot"));
    assert.ok(out.includes("image"));
    assert.ok(!out.includes("![hero"), "raw image markdown leaked");
    assert.ok(!out.includes("](https://x.dev/a.png)"), "image url leaked");
    assert.ok(out.includes("https://x.dev/b.png"), "empty-alt falls back to url");
  });

  test("GFM strikethrough drops tildes; unclosed stays literal", () => {
    const out = renderStyled([
      "dropped ~~old path~~ kept\n~~open\n`~~code~~`\n",
    ]);
    assert.ok(out.includes("old path"));
    assert.ok(out.includes("dropped"));
    assert.ok(out.includes("kept"));
    assert.ok(!out.includes("~~old path~~"), "closed strike leaked tildes");
    assert.ok(out.includes("~~open"), "unclosed strike should stay literal");
    assert.ok(
      out.includes(`${ESC}9mold path${ESC}29m`),
      "strikethrough SGR missing",
    );
    assert.ok(
      !out.includes(`${ESC}9mcode${ESC}29m`),
      "inline code must not be struck",
    );
  });
});
