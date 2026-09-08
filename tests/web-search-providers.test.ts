import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeHits,
  parseBingHtml,
  parseBraveHtml,
  parseDdgHtml,
} from "../src/agent/tools/web-search-providers.js";

describe("web-search providers", () => {
  it("parses DDG HTML result__a anchors", () => {
    const html = `
      <a rel="nofollow" class="result__a" href="https://example.com/a">Alpha</a>
      <a rel="nofollow" class="result__a" href="https://example.com/b">Beta</a>
    `;
    const hits = parseDdgHtml(html, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.title, "Alpha");
    assert.equal(hits[0]?.url, "https://example.com/a");
  });

  it("parses Bing b_algo results and drops bing.com chrome", () => {
    const html = `
      <li class="b_algo"><h2><a href="https://docs.example.com/x">Docs</a></h2>
      <div class="b_caption"><p>A useful page.</p></div></li>
      <li class="b_algo"><h2><a href="https://www.bing.com/ck/a">Ad</a></h2></li>
    `;
    const hits = parseBingHtml(html, 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.title, "Docs");
    assert.equal(hits[0]?.snippet, "A useful page.");
  });

  it("parses Brave heading-serpresult anchors", () => {
    const html = `
      <a href="https://playwright.dev/mcp" class="heading-serpresult">Playwright MCP</a>
      <a href="https://search.brave.com/x" class="heading-serpresult">Brave chrome</a>
    `;
    const hits = parseBraveHtml(html, 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.url, "https://playwright.dev/mcp");
  });

  it("interleaves unique hits across engines", () => {
    const merged = mergeHits(
      [
        [{ title: "A", url: "https://a.example/" }, { title: "A2", url: "https://a2.example/" }],
        [{ title: "A dup", url: "https://a.example" }, { title: "B", url: "https://b.example/" }],
      ],
      3,
    );
    assert.deepEqual(
      merged.map((h) => h.url),
      ["https://a.example/", "https://a2.example/", "https://b.example/"],
    );
  });
});
