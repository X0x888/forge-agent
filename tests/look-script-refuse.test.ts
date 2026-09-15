import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lookScriptWriteRefuse } from "../src/agent/tools/look-script-refuse.js";
import { toolWrite } from "../src/agent/tools/write.js";
import { toolEdit } from "../src/agent/tools/edit.js";
import { toolApplyPatch } from "../src/agent/tools/apply-patch.js";
import type { ToolContext } from "../src/agent/tools/types.js";

const dirs: string[] = [];
function tmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-look-script-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

describe("lookScriptWriteRefuse", () => {
  it("refuses looks/*.mjs and chrome/CDP names", () => {
    assert.match(
      lookScriptWriteRefuse("looks/cdp-shot.mjs") || "",
      /Chrome\/CDP look script/,
    );
    assert.match(
      lookScriptWriteRefuse("looks/chrome-launch.ts", "chrome --remote-debugging-port=9222") || "",
      /Chrome\/CDP look script/,
    );
    assert.equal(lookScriptWriteRefuse("looks/notes.md"), undefined);
    assert.equal(lookScriptWriteRefuse("src/server.mjs"), undefined);
  });

  it("write_file / search_replace / apply_patch refuse looks/*.mjs", async () => {
    const ws = tmpWorkspace();
    const ctx: ToolContext = { workspace: ws };
    const w = await toolWrite(
      {
        path: "looks/chrome-cdp.mjs",
        content: "import http from 'node:http'\n",
      },
      ctx,
    );
    assert.equal(w.isError, true);
    assert.match(w.output, /Do not write looks\/\*\.mjs/i);
    assert.equal(fs.existsSync(path.join(ws, "looks/chrome-cdp.mjs")), false);

    fs.mkdirSync(path.join(ws, "looks"), { recursive: true });
    fs.writeFileSync(path.join(ws, "looks/notes.md"), "ok\n");
    const e = await toolEdit(
      { path: "looks/shot.mjs", old_string: "a", new_string: "b" },
      ctx,
    );
    assert.equal(e.isError, true);
    assert.match(e.output, /Chrome\/CDP look script/);

    const p = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Add File: looks/cdp.mjs
+console.log("cdp")
*** End Patch
`,
      },
      ctx,
    );
    assert.equal(p.isError, true);
    assert.match(p.output, /Chrome\/CDP look script/);
  });
});
