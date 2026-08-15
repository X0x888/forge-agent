import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import {
  groupOptionsByHelpSection,
  installGroupedHelp,
} from "../src/cli/help-groups.js";

describe("groupOptionsByHelpSection", () => {
  it("bins flags into Model / Session / Safety / Harness / Output", () => {
    const groups = groupOptionsByHelpSection([
      { flags: "-m, --model <model>" },
      { flags: "-p, --provider <provider>" },
      { flags: "--session <id>" },
      { flags: "--continue" },
      { flags: "--permission-mode <mode>" },
      { flags: "--sandbox <profile>" },
      { flags: "--ulw" },
      { flags: "--max-waves <n>" },
      { flags: "--json" },
      { flags: "-h, --help" },
      { flags: "--mystery" },
    ]);
    assert.deepEqual(
      groups.map((g) => g.title),
      ["Model", "Session", "Safety", "Harness", "Output", "More"],
    );
    assert.deepEqual(
      groups.find((g) => g.title === "Model")?.options.map((o) => o.flags),
      ["-m, --model <model>", "-p, --provider <provider>"],
    );
    assert.equal(groups.find((g) => g.title === "More")?.options[0]?.flags, "--mystery");
  });

  it("does not invent a More section when everything matches", () => {
    const groups = groupOptionsByHelpSection([{ flags: "--json" }]);
    assert.deepEqual(
      groups.map((g) => g.title),
      ["Output"],
    );
  });
});

describe("installGroupedHelp", () => {
  it("replaces the flat Options: dump with scan headings", () => {
    const p = new Command();
    p.name("forge").description("test agent");
    p.option("-m, --model <model>", "Model id");
    p.option("--session <id>", "Resume session");
    p.option("--permission-mode <mode>", "Ask or yolo");
    p.option("--ulw", "Ultrawork");
    p.option("--json", "JSON");
    p.command("login").description("store credentials");
    installGroupedHelp(p);
    const help = p.helpInformation();
    assert.match(help, /Model:/);
    assert.match(help, /Session:/);
    assert.match(help, /Safety:/);
    assert.match(help, /Harness:/);
    assert.match(help, /Output:/);
    assert.match(help, /Commands:/);
    assert.match(help, /--model/);
    assert.match(help, /--session/);
    assert.doesNotMatch(help, /^Options:/m);
    // implicit --help lands in Output, not a leftover dump
    assert.match(help, /--help/);
  });
});
