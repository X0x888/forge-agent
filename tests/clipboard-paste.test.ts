import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveClipboardImage } from "../src/util/clipboard.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("/paste clipboard image", () => {
  it("saveClipboardImage fails closed when clipboard has no image", () => {
    const r = saveClipboardImage();
    if (r.ok) {
      assert.match(r.path, /paste-\d+\.png$/);
      assert.ok(fs.existsSync(r.path));
      return;
    }
    assert.match(r.error, /clipboard|pngpaste|wl-paste|xclip/i);
  });

  it("/paste is handled and either attaches or reports failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-paste-"));
    process.env.FORGE_HOME = tmp;
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const r = await handleSlash("/paste", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: new HookRunner(DEFAULT_CONFIG, tmp),
    });
    assert.equal(r.handled, true);
    if (r.forwardPrompt || r.queueInterjection) {
      assert.match(String(r.forwardPrompt || r.queueInterjection), /\[\[image:/);
    } else {
      assert.match(String(r.output), /Clipboard paste failed/i);
    }
  });
});
