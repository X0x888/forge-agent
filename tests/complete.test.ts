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
  });

  it("completes cycle params", () => {
    const [hits] = forgeCompleter("/cycle ");
    assert.ok(hits.some((h) => h.endsWith(" 1") || h.includes(" 1")));
  });
});

describe("param resolve + menu", () => {
  it("resolves numbers and aliases for permissions", () => {
    const c = COMMAND_PARAMS.permissions;
    assert.equal(resolveParamChoice("1", c), "default");
    assert.equal(resolveParamChoice("4", c), "bypassPermissions");
    assert.equal(resolveParamChoice("yolo", c), "bypassPermissions");
    assert.equal(resolveParamChoice("always", c), "bypassPermissions");
    assert.equal(resolveParamChoice("accept", c), "acceptEdits");
    assert.equal(resolveParamChoice("bypass", c), "bypassPermissions");
  });

  it("formats a menu with current marker", () => {
    const menu = formatParamMenu("/permissions", COMMAND_PARAMS.permissions, "default");
    assert.match(menu, /1\.\s+default/);
    assert.match(menu, /current/);
    assert.match(menu, /bypassPermissions/);
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
