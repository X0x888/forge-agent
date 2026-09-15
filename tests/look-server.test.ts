import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  isLookPortListening,
  lookServerSpawnArgs,
  lookServerUrl,
} from "../src/util/look-server.js";
import { lookPortForSession } from "../src/util/look-port.js";
import { extensionLookDir } from "../src/util/product-kind.js";

describe("look-server", () => {
  it("lookServerUrl uses the session look port", () => {
    const sid = "18747acb-886a-4792-a711-026398fd66d8";
    assert.equal(lookServerUrl(sid), `http://127.0.0.1:${lookPortForSession(sid)}`);
  });

  it("spawns vite on a Vite tree and skips native", () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), "forge-look-web-"));
    const native = fs.mkdtempSync(path.join(os.tmpdir(), "forge-look-native-"));
    try {
      fs.writeFileSync(path.join(web, "vite.config.ts"), "export default {}\n");
      fs.writeFileSync(path.join(web, "index.html"), "<h1>x</h1>\n");
      const spec = lookServerSpawnArgs(web, 5321);
      assert.ok(spec);
      assert.equal(spec!.command, "npx");
      assert.ok(spec!.args.includes("vite"));
      assert.ok(spec!.args.includes("5321"));
      assert.ok(spec!.args.includes("--strictPort"));

      fs.writeFileSync(path.join(native, "Package.swift"), "// swift-tools-version: 5.9\n");
      fs.mkdirSync(path.join(native, "Sources"));
      assert.equal(lookServerSpawnArgs(native, 5321), undefined);
    } finally {
      fs.rmSync(web, { recursive: true, force: true });
      fs.rmSync(native, { recursive: true, force: true });
    }
  });

  it("serves an unpacked extension from public, not leftover dist", () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), "forge-look-ext-"));
    try {
      fs.mkdirSync(path.join(ext, "extension", "public"), { recursive: true });
      fs.mkdirSync(path.join(ext, "extension", "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(ext, "extension", "manifest.json"),
        JSON.stringify({ action: {}, name: "pet" }),
      );
      fs.writeFileSync(path.join(ext, "extension", "public", "popup.html"), "<h1>src</h1>\n");
      fs.writeFileSync(path.join(ext, "extension", "dist", "popup.html"), "<h1>stale</h1>\n");
      const dir = extensionLookDir(ext);
      assert.ok(dir);
      assert.match(dir!, /public$/);
      const spec = lookServerSpawnArgs(ext, 5322);
      assert.ok(spec);
      assert.equal(spec!.command, "python3");
      assert.ok(spec!.args.includes("--directory"));
      assert.ok(spec!.args.some((a) => a.includes("public")));
      assert.ok(!spec!.args.some((a) => /dist$/.test(a)));
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });

  it("isLookPortListening sees a bound port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;
    try {
      assert.equal(await isLookPortListening(port), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(await isLookPortListening(port), false);
  });
});
