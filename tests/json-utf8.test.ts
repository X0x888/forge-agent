import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  jsonStringifyUtf8,
  replaceUnpairedSurrogates,
  sliceUtf16Safe,
} from "../src/util/json-utf8.js";
import { truncateMiddle } from "../src/util/format.js";

/** serde_json: `\uD800`-`\uDBFF` must be followed by a low-surrogate `\uDC00`-`\uDFFF`. */
function serdeRejectsLoneHighSurrogateEscape(json: string): boolean {
  const re = /\\u[dD][89abAB][0-9a-fA-F]{2}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json))) {
    const rest = json.slice(m.index + m[0].length);
    if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}/.test(rest)) return true;
  }
  return false;
}

function hasUnpaired(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    s,
  );
}

describe("json-utf8 / unpaired surrogates", () => {
  const fire = "🔥"; // U+1F525 → UTF-16 D83D DD25
  const high = fire.slice(0, 1);
  const low = fire.slice(1);

  it("JSON.stringify of a split emoji is the xAI 400 class", () => {
    assert.equal(high.charCodeAt(0), 0xd83d);
    const raw = JSON.stringify({
      content: `unique features: ${high}\n\n_Source: DuckDuckGo`,
    });
    assert.equal(serdeRejectsLoneHighSurrogateEscape(raw), true);
    assert.match(raw, /\\ud83d/i);
  });

  it("jsonStringifyUtf8 never emits a lone high-surrogate escape", () => {
    const payload = {
      messages: [
        {
          role: "tool",
          content: `unique features: ${high}\n\n_Source: DuckDuckGo`,
        },
      ],
    };
    const json = jsonStringifyUtf8(payload);
    assert.equal(serdeRejectsLoneHighSurrogateEscape(json), false);
    const parsed = JSON.parse(json) as typeof payload;
    assert.equal(hasUnpaired(parsed.messages[0]!.content), false);
    assert.match(parsed.messages[0]!.content, /\uFFFD/);
    assert.doesNotMatch(json, /\\ud[89ab][0-9a-f]{2}/i);
  });

  it("preserves a complete emoji (paired surrogates)", () => {
    const json = jsonStringifyUtf8({ content: `ok ${fire} done` });
    assert.equal(JSON.parse(json).content, `ok ${fire} done`);
    // Paired \ud83d\udd25 is fine for serde
    assert.equal(serdeRejectsLoneHighSurrogateEscape(json), false);
  });

  it("replaceUnpairedSurrogates drops both halves", () => {
    assert.equal(replaceUnpairedSurrogates(high), "\uFFFD");
    assert.equal(replaceUnpairedSurrogates(low), "\uFFFD");
    assert.equal(replaceUnpairedSurrogates(`a${fire}b`), `a${fire}b`);
  });

  it("sliceUtf16Safe does not split an emoji", () => {
    const s = `ab${fire}cd`; // a b H L c d
    // slice(0, 3) keeps the high surrogate of 🔥
    assert.equal(hasUnpaired(s.slice(0, 3)), true);
    assert.equal(hasUnpaired(sliceUtf16Safe(s, 0, 3)), false);
    assert.equal(sliceUtf16Safe(s, 0, 3), "ab");
    // slice(3) starts on the low surrogate
    assert.equal(hasUnpaired(s.slice(3)), true);
    assert.equal(hasUnpaired(sliceUtf16Safe(s, 3)), false);
    assert.equal(sliceUtf16Safe(s, 3), "cd");
  });

  it("truncateMiddle does not emit unpaired surrogates", () => {
    const s = fire.repeat(80);
    const t = truncateMiddle(s, 20);
    assert.equal(hasUnpaired(t), false);
    assert.equal(serdeRejectsLoneHighSurrogateEscape(JSON.stringify({ t })), false);
    assert.equal(
      serdeRejectsLoneHighSurrogateEscape(jsonStringifyUtf8({ t })),
      false,
    );
  });

  it("truncateMiddle sanitizes an already-split emoji under the cap", () => {
    const t = truncateMiddle(`unique features: ${high}\n`, 80_000);
    assert.equal(hasUnpaired(t), false);
    assert.match(t, /\uFFFD/);
  });
});
