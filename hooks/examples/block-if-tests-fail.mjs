#!/usr/bin/env node
/**
 * Example Stop hook: block agent exit if `npm test` fails.
 * Copy into ~/.forge/hooks/ or .forge/hooks/ via a JSON wrapper.
 *
 * Claude Code semantics: exit 2 or decision:block keeps the agent working.
 * This is what Grok Build cannot do (Stop is passive there).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  payload = {};
}

const cwd = payload.cwd || process.cwd();
const pkg = `${cwd}/package.json`;

if (!fs.existsSync(pkg)) {
  console.log(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}

try {
  execSync("npm test --silent", {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  });
  console.log(JSON.stringify({ decision: "allow" }));
  process.exit(0);
} catch (err) {
  const msg =
    (err.stderr?.toString() || err.stdout?.toString() || err.message || "").slice(
      0,
      1500,
    );
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `Tests failed — keep working until green.\n${msg}`,
      additionalContext: `Stop blocked: npm test failed. Fix failures, re-run tests, then stop only when green.\n${msg}`,
    }),
  );
  process.exit(2);
}
