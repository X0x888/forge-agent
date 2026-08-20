import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  helpFor,
  parseHelpCatalog,
  parseHelpCatalogLine,
  searchHelpCatalog,
  formatHelpSearchEmpty,
  formatHelpSearchCard,
  HELP_START,
} from "../src/commands/help-text.js";

describe("help catalog parse", () => {
  it("reads a usage + blurb row and strips [live]", () => {
    const e = parseHelpCatalogLine(
      "  /budget [usd|off]     Session spend cap (estimate USD)  [live]",
    );
    assert.ok(e);
    assert.equal(e!.command, "/budget");
    assert.equal(e!.blurb, "Session spend cap (estimate USD)");
    assert.match(e!.usage, /\/budget/);
  });

  it("indexes alias slashes on the same row", () => {
    const e = parseHelpCatalogLine(
      "  /status · /hud        Full inline HUD + session details",
    );
    assert.ok(e);
    assert.equal(e!.command, "/status");
    assert.deepEqual(e!.aliases, ["/hud"]);
  });

  it("indexes parenthetical aliases in the blurb", () => {
    const e = parseHelpCatalogLine(
      "  /rewind [n]           Undo last n user turns (/undo)",
    );
    assert.ok(e);
    assert.equal(e!.command, "/rewind");
    assert.ok(e!.aliases.includes("/undo"));
  });

  it("skips non-command rows", () => {
    assert.equal(parseHelpCatalogLine("Getting started"), null);
    assert.equal(parseHelpCatalogLine("  ask_user              Model tool"), null);
  });

  it("parses the live catalog", () => {
    const cat = parseHelpCatalog();
    assert.ok(cat.some((e) => e.command === "/budget"));
    assert.ok(cat.some((e) => e.command === "/undo"));
    assert.ok(cat.length >= 20);
  });
});

describe("searchHelpCatalog", () => {
  it("finds a command by name", () => {
    const hits = searchHelpCatalog("budget");
    assert.equal(hits[0]?.command, "/budget");
    assert.ok((hits[0]?.score ?? 0) >= 100);
  });

  it("finds /undo when given a leading slash", () => {
    const hits = searchHelpCatalog("/undo");
    assert.equal(hits[0]?.command, "/undo");
  });

  it("finds /verify by the proof-trail job word", () => {
    const hits = searchHelpCatalog("verify");
    assert.equal(hits[0]?.command, "/verify");
  });

  it("finds spend-cap via the blurb job word", () => {
    const hits = searchHelpCatalog("spend");
    assert.ok(hits.some((h) => h.command === "/budget"));
  });

  it("recovers a command typo", () => {
    const hits = searchHelpCatalog("budjet");
    assert.equal(hits[0]?.command, "/budget");
  });

  it("returns nothing for a nonsense word", () => {
    assert.deepEqual(searchHelpCatalog("nope"), []);
    assert.deepEqual(searchHelpCatalog(""), []);
  });

  it("caps the card", () => {
    const hits = searchHelpCatalog("on", { max: 3 });
    assert.ok(hits.length <= 3);
  });
});

describe("help search cards", () => {
  it("empty state names the query and next keys", () => {
    const text = formatHelpSearchEmpty("nope");
    assert.match(text, /No help for “nope”/);
    assert.match(text, /\/help all/);
    assert.doesNotMatch(text, /Unknown \/help topic/);
  });

  it("hit card lists commands and more keys", () => {
    const hits = searchHelpCatalog("budget");
    const card = formatHelpSearchCard("budget", hits, { columns: 80 });
    assert.match(card, /Help  ·  “budget”/);
    assert.match(card, /\/budget/);
    assert.match(card, /More  \/help/);
  });
});

describe("helpFor word search", () => {
  it("topics still route", () => {
    assert.equal(helpFor("").topic, "start");
    assert.equal(helpFor("all").topic, "all");
    assert.equal(helpFor("settings").topic, "settings");
  });

  it("job words search instead of failing closed", () => {
    const h = helpFor("budget");
    assert.equal(h.topic, "search");
    assert.match(h.text, /\/budget/);
    assert.doesNotMatch(h.text, /Unknown \/help topic/);
  });

  it("designed empty state for no matches", () => {
    const h = helpFor("nope");
    assert.equal(h.topic, "unknown");
    assert.match(h.text, /No help for “nope”/);
    assert.doesNotMatch(h.text, /Unknown \/help topic/);
  });

  it("topic typo opens that topic", () => {
    const h = helpFor("setings");
    assert.equal(h.topic, "settings");
    assert.match(h.text, /Showing settings/);
    assert.match(h.text, /\/budget/);
  });

  it("start card advertises word search", () => {
    assert.match(HELP_START, /\/help <word>/);
    assert.match(helpFor("").text, /Find a command/);
  });
});
