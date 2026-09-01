/**
 * Stacks the check table did not know: Swift, Zig, .NET, Dart, and
 * repo-local check scripts. A Swift menu-bar app ran `./build.sh &&
 * --self-test` twenty times in one dogfood run and earned proof=✗ every time.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearProjectIntelCache,
  detectProjectIntel,
  localCheckScripts,
} from "../src/util/project-intel.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, body: string, mode?: number): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  if (mode != null) fs.chmodSync(p, mode);
}

describe("project-intel: more stacks", () => {
  it("Package.swift → swift build / swift test", () => {
    const root = tmpDir("forge-intel-swift-");
    fs.mkdirSync(path.join(root, ".git"));
    write(root, "Package.swift", "// swift-tools-version:5.9\n");
    clearProjectIntelCache();
    const intel = detectProjectIntel(root);
    assert.ok(intel.checkCommands.includes("swift build"), intel.checkCommands.join(","));
    assert.ok(intel.checkCommands.includes("swift test"));
  });

  it("build.zig → zig build test; *.csproj → dotnet test; pubspec → dart/flutter test", () => {
    const zig = tmpDir("forge-intel-zig-");
    fs.mkdirSync(path.join(zig, ".git"));
    write(zig, "build.zig", "const std = @import(\"std\");\n");
    clearProjectIntelCache();
    assert.ok(detectProjectIntel(zig).checkCommands.includes("zig build test"));

    const net = tmpDir("forge-intel-dotnet-");
    fs.mkdirSync(path.join(net, ".git"));
    write(net, "App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n");
    clearProjectIntelCache();
    assert.ok(detectProjectIntel(net).checkCommands.includes("dotnet test"));

    const dart = tmpDir("forge-intel-dart-");
    fs.mkdirSync(path.join(dart, ".git"));
    write(dart, "pubspec.yaml", "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n");
    clearProjectIntelCache();
    assert.ok(detectProjectIntel(dart).checkCommands.includes("flutter test"));

    const plainDart = tmpDir("forge-intel-dart2-");
    fs.mkdirSync(path.join(plainDart, ".git"));
    write(plainDart, "pubspec.yaml", "name: lib\n");
    clearProjectIntelCache();
    assert.ok(detectProjectIntel(plainDart).checkCommands.includes("dart test"));
  });

  it("executable ./build.sh / ./test.sh / scripts/check.sh are preferred checks; non-executable prose scripts are not", () => {
    const root = tmpDir("forge-intel-scripts-");
    fs.mkdirSync(path.join(root, ".git"));
    write(root, "build.sh", "#!/bin/sh\nswiftc Sources/main.swift\n", 0o755);
    write(root, "test.sh", "set -e\n./build/app --self-test\n", 0o644); // shebang-less, not executable
    write(root, "scripts/check.sh", "#!/usr/bin/env bash\nnpm test\n", 0o644); // shebang counts
    write(root, "deploy.sh", "#!/bin/sh\necho deploy\n", 0o755); // not a check name
    const scripts = localCheckScripts(root);
    assert.deepEqual(scripts, ["./build.sh", "scripts/check.sh"]);
    clearProjectIntelCache();
    const intel = detectProjectIntel(root);
    assert.ok(intel.checkCommands.includes("./build.sh"), intel.checkCommands.join(","));
    assert.equal(intel.checkCommands.includes("./deploy.sh"), false);
  });

  it("node projects keep their scripts first; local check scripts come after", () => {
    const root = tmpDir("forge-intel-node-scripts-");
    fs.mkdirSync(path.join(root, ".git"));
    write(root, "package.json", JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
    write(root, "package-lock.json", "{}");
    write(root, "check.sh", "#!/bin/sh\nnpm test\n", 0o755);
    clearProjectIntelCache();
    const intel = detectProjectIntel(root);
    assert.equal(intel.checkCommands[0], "npm test");
    assert.ok(intel.checkCommands.includes("./check.sh"));
  });
});
