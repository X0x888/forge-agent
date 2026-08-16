import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Chalk } from "chalk";
import {
  highlightFenceLine,
  langFamily,
} from "../src/tui/syntax.js";

const c = new Chalk({ level: 1 });

function hi(line: string, lang = "ts", state = { inBlockComment: false }) {
  return highlightFenceLine(line, lang, c, state);
}

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("langFamily", () => {
  test("maps common aliases", () => {
    assert.equal(langFamily("TypeScript"), "js");
    assert.equal(langFamily("tsx"), "js");
    assert.equal(langFamily("python"), "py");
    assert.equal(langFamily("bash"), "sh");
    assert.equal(langFamily("jsonc"), "json");
    assert.equal(langFamily("patch"), "diff");
    assert.equal(langFamily(""), "generic");
  });
});

describe("highlightFenceLine", () => {
  test("keeps source text after stripping ANSI", () => {
    const src = `const x = 1; // n`;
    assert.equal(strip(hi(src).text), src);
  });

  test("colors js keywords / numbers / strings", () => {
    const { text } = hi(`const x = 1;`);
    assert.ok(text.includes("\x1b[35mconst\x1b[39m"));
    assert.ok(text.includes("\x1b[33m1\x1b[39m"));
  });

  test("carries block-comment state across lines", () => {
    const a = hi("foo /* start");
    assert.equal(a.state.inBlockComment, true);
    const b = hi("still commented", "ts", a.state);
    assert.equal(strip(b.text), "still commented");
    assert.equal(b.state.inBlockComment, true);
    const d = hi("end */ const y = 2;", "ts", b.state);
    assert.equal(d.state.inBlockComment, false);
    assert.equal(strip(d.text), "end */ const y = 2;");
    assert.ok(d.text.includes("\x1b[35mconst\x1b[39m"));
  });

  test("diff paints + green and - red", () => {
    const plus = hi("+added", "diff");
    const minus = hi("-gone", "diff");
    assert.ok(plus.text.includes("\x1b[32m+added\x1b[39m"));
    assert.ok(minus.text.includes("\x1b[31m-gone\x1b[39m"));
    assert.equal(plus.state.inBlockComment, false);
  });

  test("python hashes are comments; def is a keyword", () => {
    const { text } = hi("def foo():  # n", "py");
    assert.ok(text.includes("\x1b[35mdef\x1b[39m"));
    assert.ok(text.includes("# n"));
  });

  test("generic #fff is not a comment", () => {
    const { text } = hi("color: #fff;", "");
    assert.equal(strip(text), "color: #fff;");
    assert.ok(!text.includes("\x1b[2m#fff"));
  });
});
