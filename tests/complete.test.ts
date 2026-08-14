import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  forgeCompleter,
  resolveParamChoice,
  formatParamMenu,
  COMMAND_PARAMS,
  EMPTY_TAB_STARTERS,
} from "../src/tui/complete.js";
import { SLASH_COMMANDS } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("tab completion", () => {
  it("empty Tab offers curated starters, not the full catalog", () => {
    const [hits] = forgeCompleter("");
    assert.deepEqual(hits, [...EMPTY_TAB_STARTERS]);
    assert.ok(hits.length < 20);
    assert.ok(hits.includes("/help"));
    assert.ok(hits.includes("/setup"));
    assert.ok(hits.includes("/plan"));
    assert.ok(!hits.includes("/ralph"));
    assert.ok(SLASH_COMMANDS.length > hits.length);
  });

  it("slash-only Tab still lists the full catalog", () => {
    const [hits] = forgeCompleter("/");
    assert.ok(hits.includes("/help"));
    assert.ok(hits.includes("/ralph"));
    assert.ok(hits.length >= SLASH_COMMANDS.length);
  });

  it("completes slash command prefixes", () => {
    const [hits] = forgeCompleter("/per");
    assert.ok(hits.some((h) => h.startsWith("/permissions")));
  });

  it("completes permission modes", () => {
    const [hits] = forgeCompleter("/permissions by");
    assert.ok(hits.some((h) => h.includes("bypassPermissions")));
  });

  it("lists all modes after space", () => {
    const [hits] = forgeCompleter("/permissions ");
    assert.ok(hits.length >= 5);
    assert.ok(hits.some((h) => h.includes("dontAsk")));
    assert.ok(hits.every((h) => h.startsWith("/permissions ")));
    assert.ok(hits.some((h) => h.includes("list")));
    assert.ok(hits.some((h) => h.includes("clear")));
    assert.ok(hits.some((h) => h.includes("revoke")));
  });

  it("completes cycle params", () => {
    const [hits] = forgeCompleter("/cycle ");
    assert.ok(hits.some((h) => h.endsWith(" 1") || h.includes(" 1")));
  });

  it("completes new expert slash commands", () => {
    const [forkHits] = forgeCompleter("/for");
    assert.ok(forkHits.some((h) => h.startsWith("/fork")));
    assert.ok(forkHits.some((h) => h.startsWith("/fork-and-compact")));
    const [diffHits] = forgeCompleter("/di");
    assert.ok(diffHits.some((h) => h.startsWith("/diff")));
    const [metHits] = forgeCompleter("/met");
    assert.ok(metHits.some((h) => h.startsWith("/metrics")));
    const [expHits] = forgeCompleter("/export ");
    assert.ok(expHits.some((h) => h.includes("--json")));
    const [initHits] = forgeCompleter("/in");
    assert.ok(initHits.some((h) => h.startsWith("/init")));
    const [revHits] = forgeCompleter("/rev");
    assert.ok(revHits.some((h) => h.startsWith("/review")));
    const [logHits] = forgeCompleter("/lo");
    assert.ok(logHits.some((h) => h.startsWith("/logs")));
    const [pasteHits] = forgeCompleter("/pas");
    assert.ok(pasteHits.some((h) => h.startsWith("/paste")));
    const [undHits] = forgeCompleter("/un");
    assert.ok(undHits.some((h) => h.startsWith("/undo") || h.startsWith("/unpause") || h.startsWith("/unpin")));
    const [compHits] = forgeCompleter("/compact");
    assert.ok(compHits.some((h) => h === "/compact" || h.startsWith("/compact")));
    assert.ok(compHits.some((h) => h.startsWith("/compact-and")));
    const [revParams] = forgeCompleter("/review ");
    assert.ok(revParams.some((h) => h.includes("uncommitted") || h.includes("staged")));
    const [logParams] = forgeCompleter("/logs ");
    assert.ok(logParams.some((h) => h.includes("path") || h.includes("20")));
    assert.ok(logParams.some((h) => h.includes(" 0") || h.endsWith("0")));
    const [cfgHits] = forgeCompleter("/con");
    assert.ok(cfgHits.some((h) => h.startsWith("/config")));
    const [cfgParams] = forgeCompleter("/config ");
    assert.ok(cfgParams.some((h) => h.includes("json")));
    const [verbHits] = forgeCompleter("/verb");
    assert.ok(verbHits.some((h) => h.startsWith("/verbose")));
    const [skillHits] = forgeCompleter("/ski");
    assert.ok(skillHits.some((h) => h.startsWith("/skills")));
  });
});

describe("param resolve + menu", () => {
  it("resolves numbers and aliases for permissions", () => {
    const c = COMMAND_PARAMS.permissions;
    assert.equal(resolveParamChoice("1", c), "default");
    assert.equal(resolveParamChoice("4", c), "bypassPermissions");
    assert.equal(resolveParamChoice("5", c), "dontAsk");
    assert.equal(resolveParamChoice("6", c), "list");
    assert.equal(resolveParamChoice("yolo", c), "bypassPermissions");
    assert.equal(resolveParamChoice("dont-ask", c), "dontAsk");
    assert.equal(resolveParamChoice("deny", c), "dontAsk");
    assert.equal(resolveParamChoice("always", c), "bypassPermissions");
    assert.equal(resolveParamChoice("accept", c), "acceptEdits");
    assert.equal(resolveParamChoice("bypass", c), "bypassPermissions");
    assert.equal(resolveParamChoice("list", c), "list");
    assert.equal(resolveParamChoice("build", c), "build");
    assert.equal(resolveParamChoice("execute", c), "build");
  });

  it("formats a menu with current marker", () => {
    const modes = COMMAND_PARAMS.permissions.filter((c) =>
      ["default", "acceptEdits", "plan", "bypassPermissions"].includes(c.value),
    );
    const menu = formatParamMenu("/permissions", modes, "default");
    assert.match(menu, /1\.\s+default/);
    assert.match(menu, /current/);
    assert.match(menu, /bypassPermissions/);
    assert.ok(!menu.includes("list"));
  });

  it("completes models from config", () => {
    const [hits] = forgeCompleter("/model gr", {
      ...DEFAULT_CONFIG,
      provider: "xai",
      model: "grok-4",
    });
    assert.ok(hits.some((h) => h.includes("grok")));
  });
});
