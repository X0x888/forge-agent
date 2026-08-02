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
    "Some **bold** and *italic* and `inline code` here.",
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
    "A [link](https://example.com/p?a=1&b=2) here.\n> quoted line\n---\n1. first\n2. second\n",
  trailingBold: "Trailing **bold without close",
  headingOnly: "### Deep heading",
  snakeCase: "snake_case_names stay literal but _this_ is italic\n",
  noTrailingNewline: "one line, no newline",
  empty: "",
  fenceAtEnd: "text\n```\ncode line\n```",
  crlf: "line one\r\nline two\r\n",
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

  test("headings are bold + underlined with # stripped", () => {
    const out = renderStyled(["# Title\n"]);
    assert.ok(out.includes(`${ESC}1m`), "bold missing");
    assert.ok(out.includes(`${ESC}4m`), "underline missing");
    assert.ok(out.includes("Title"));
    assert.ok(!out.includes("# Title"));
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
    assert.ok(out.includes("│"), "code gutter missing");
    assert.ok(out.includes("const a = 1;"));
  });

  test("heading at chunk edge is still a heading", () => {
    const out = renderStyled(["intro\n## Sub", "head\nnext\n"]);
    assert.ok(out.includes(`${ESC}4m`), "underline missing");
    assert.ok(out.includes("Subhead"));
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
});
