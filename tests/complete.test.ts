import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  forgeCompleter,
  resolveParamChoice,
  formatParamMenu,
  COMMAND_PARAMS,
} from "../src/tui/complete.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("tab completion", () => {
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
    assert.ok(hits.length >= 4);
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
    const [diffHits] = forgeCompleter("/di");
    assert.ok(diffHits.some((h) => h.startsWith("/diff")));
    const [metHits] = forgeCompleter("/met");
    assert.ok(metHits.some((h) => h.startsWith("/metrics")));
    const [expHits] = forgeCompleter("/export ");
    assert.ok(expHits.some((h) => h.includes("--json")));
  });
});

describe("param resolve + menu", () => {
  it("resolves numbers and aliases for permissions", () => {
    const c = COMMAND_PARAMS.permissions;
    assert.equal(resolveParamChoice("1", c), "default");
    assert.equal(resolveParamChoice("4", c), "bypassPermissions");
    assert.equal(resolveParamChoice("5", c), "list");
    assert.equal(resolveParamChoice("yolo", c), "bypassPermissions");
    assert.equal(resolveParamChoice("always", c), "bypassPermissions");
    assert.equal(resolveParamChoice("accept", c), "acceptEdits");
    assert.equal(resolveParamChoice("bypass", c), "bypassPermissions");
    assert.equal(resolveParamChoice("list", c), "list");
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
