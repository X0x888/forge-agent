/**
 * Path-prefix always grants for write/edit tools.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { alwaysPatternFromPath } from "../src/agent/permissions.js";
import {
  compileRules,
  evaluateRules,
  extractPatchPaths,
} from "../src/agent/rules.js";

describe("alwaysPatternFromPath", () => {
  const ws = "/proj";
  it("grants directory/** for nested file paths", () => {
    assert.equal(
      alwaysPatternFromPath("src/agent/worktree.ts", ws),
      "src/agent/**",
    );
    assert.equal(
      alwaysPatternFromPath("/proj/src/agent/tools/foo.ts", ws),
      "src/agent/tools/**",
    );
    assert.equal(alwaysPatternFromPath("README.md", ws), "*");
    assert.equal(alwaysPatternFromPath("", ws), "*");
  });

  it("caps depth at 4 segments", () => {
    assert.equal(
      alwaysPatternFromPath("a/b/c/d/e/f/g.ts", ws),
      "a/b/c/d/**",
    );
  });
});

describe("write/edit path-prefix allow rules", () => {
  const ws = "/proj";
  it("allows write_file under granted directory", () => {
    const rules = compileRules({ allow: ["write_file(src/agent/**)"] });
    const ok = evaluateRules(
      rules,
      "write_file",
      { path: "src/agent/worktree.ts" },
      ws,
    );
    assert.equal(ok.decision, "allow");
    const nested = evaluateRules(
      rules,
      "write_file",
      { path: "src/agent/tools/x.ts" },
      ws,
    );
    assert.equal(nested.decision, "allow");
    const outside = evaluateRules(
      rules,
      "write_file",
      { path: "src/other/x.ts" },
      ws,
    );
    assert.equal(outside.decision, "none");
  });

  it("allows search_replace under granted directory", () => {
    const rules = compileRules({ allow: ["search_replace(src/**)"] });
    const ok = evaluateRules(
      rules,
      "search_replace",
      { path: "src/cli.ts", old_string: "a", new_string: "b" },
      ws,
    );
    assert.equal(ok.decision, "allow");
  });

  it("extractPatchPaths + apply_patch directory grant", () => {
    const patch = `*** Begin Patch
*** Update File: src/agent/worktree.ts
@@
-a
+b
*** Add File: src/agent/tools/new.ts
@@
+hi
*** End Patch
`;
    const paths = extractPatchPaths(patch);
    assert.ok(paths.includes("src/agent/worktree.ts"));
    assert.ok(paths.includes("src/agent/tools/new.ts"));

    const rules = compileRules({ allow: ["apply_patch(src/agent/**)"] });
    const ok = evaluateRules(
      rules,
      "apply_patch",
      { patchText: patch },
      ws,
    );
    assert.equal(ok.decision, "allow");

    const outside = evaluateRules(
      rules,
      "apply_patch",
      {
        patchText: `*** Begin Patch\n*** Update File: README.md\n@@\n-a\n+b\n*** End Patch\n`,
      },
      ws,
    );
    assert.equal(outside.decision, "none");
  });
});
