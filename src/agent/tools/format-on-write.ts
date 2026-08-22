/**
 * Opt-in format-on-write (OpenCode-inspired).
 *
 * After a successful write_file / search_replace / apply_patch, optionally run
 * a project-local formatter. Never fails the tool — format errors are ignored.
 *
 * Enable via:
 *   - FORGE_FORMAT_ON_WRITE=1
 *   - preferences.json formatOnWrite: true
 *   - auto (default): when a project formatter is detectably configured
 *     (prettier dep / biome.json / ruff config / gofmt|rustfmt on PATH for
 *     matching files) and the user has not set formatOnWrite=false.
 * Disable explicitly with FORGE_FORMAT_ON_WRITE=0 or `/format off`
 * (wins over auto + preference).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadPreferences } from "../../config/preferences.js";
import { createChildEnv } from "./env-policy.js";

export type FormatResult = {
  formatter: string;
  ok: boolean;
  detail?: string;
};

function which(bin: string): string | null {
  const pathEnv = process.env.PATH || "";
  const seps = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of seps) {
    for (const ext of exts) {
      const cand = path.join(dir, bin + ext);
      try {
        fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch {
        /* */
      }
    }
  }
  return null;
}

function findUp(
  startDir: string,
  names: string[],
  stopAt?: string,
): string | null {
  let dir = path.resolve(startDir);
  const stop = stopAt ? path.resolve(stopAt) : path.parse(dir).root;
  for (;;) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* */
      }
    }
    if (dir === stop || dir === path.parse(dir).root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasDep(pkg: Record<string, unknown> | null, name: string): boolean {
  if (!pkg) return false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const block = pkg[key];
    if (block && typeof block === "object" && name in (block as object)) {
      return true;
    }
  }
  return false;
}

function npmBin(name: string, workspace: string): string | null {
  // Prefer local node_modules/.bin
  const local = path.join(workspace, "node_modules", ".bin", name);
  try {
    if (fs.existsSync(local)) return local;
  } catch {
    /* */
  }
  // Walk up for monorepos
  const up = findUp(workspace, [path.join("node_modules", ".bin", name)]);
  if (up) return up;
  return which(name);
}

/**
 * True when format-on-write should run after file tools.
 * Precedence: env FORGE_FORMAT_ON_WRITE > preferences.formatOnWrite >
 * auto-detect (project formatter configured).
 */
export function isFormatOnWriteEnabled(workspace?: string): boolean {
  const env = process.env.FORGE_FORMAT_ON_WRITE;
  if (env != null && String(env).trim() !== "") {
    const v = String(env).trim().toLowerCase();
    if (["0", "false", "off", "no"].includes(v)) return false;
    if (["1", "true", "on", "yes"].includes(v)) return true;
    // "auto" falls through to detection below
  }
  try {
    const prefs = loadPreferences();
    if (typeof prefs.formatOnWrite === "boolean") {
      return prefs.formatOnWrite;
    }
  } catch {
    /* */
  }
  // Auto: enable when a project formatter is clearly configured.
  // Avoid surprising users with no formatter tooling installed.
  return isProjectFormatterConfigured(workspace || process.cwd());
}

/** Lightweight "is there something to run?" probe for auto format-on-write. */
export function isProjectFormatterConfigured(workspace: string): boolean {
  const root = path.resolve(workspace || process.cwd());
  try {
    // Walk up from workspace so monorepo packages inherit root tooling.
    // Biome config
    const biomeCfg = findUp(root, ["biome.json", "biome.jsonc"]);
    if (biomeCfg && (npmBin("biome", root) || which("biome"))) return true;

    // package.json with prettier / biome dependency (nearest first)
    let dir = root;
    for (let hop = 0; hop < 8; hop++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = readJsonSafe(pkgPath);
        if (
          hasDep(pkg, "prettier") &&
          (npmBin("prettier", dir) || which("prettier"))
        ) {
          return true;
        }
        if (
          hasDep(pkg, "@biomejs/biome") &&
          (npmBin("biome", dir) || which("biome"))
        ) {
          return true;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Ruff
    const ruffCfg = findUp(root, ["ruff.toml", ".ruff.toml"]);
    if (ruffCfg && which("ruff")) return true;
    const pyproject = findUp(root, ["pyproject.toml"]);
    if (pyproject && which("ruff")) {
      try {
        const txt = fs.readFileSync(pyproject, "utf8");
        if (txt.includes("[tool.ruff")) return true;
      } catch {
        /* */
      }
    }

    // Language-native formatters when project markers exist
    if (findUp(root, ["go.mod"]) && which("gofmt")) return true;
    if (findUp(root, ["Cargo.toml"]) && which("rustfmt")) return true;
  } catch {
    /* */
  }
  return false;
}

type Cmd = { formatter: string; argv: string[]; cwd?: string };

function resolveFormatter(
  filePath: string,
  workspace: string,
): Cmd | null {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const stop = workspace;

  // Biome (config present)
  if (
    [
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".json",
      ".jsonc",
      ".css",
      ".md",
    ].includes(ext)
  ) {
    const biomeCfg = findUp(dir, ["biome.json", "biome.jsonc"], stop);
    if (biomeCfg) {
      const bin = npmBin("biome", workspace) || which("biome");
      if (bin) {
        return {
          formatter: "biome",
          argv: [bin, "format", "--write", filePath],
          cwd: path.dirname(biomeCfg),
        };
      }
    }
  }

  // Prettier (dependency in package.json)
  if (
    [
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".json",
      ".jsonc",
      ".css",
      ".scss",
      ".md",
      ".mdx",
      ".yml",
      ".yaml",
      ".html",
    ].includes(ext)
  ) {
    const pkgPath = findUp(dir, ["package.json"], stop);
    if (pkgPath) {
      const pkg = readJsonSafe(pkgPath);
      if (hasDep(pkg, "prettier")) {
        const bin = npmBin("prettier", workspace) || which("prettier");
        if (bin) {
          return {
            formatter: "prettier",
            argv: [bin, "--write", filePath],
            cwd: path.dirname(pkgPath),
          };
        }
      }
    }
  }

  // Ruff (Python) — only when config present or ruff on PATH with .py
  if (ext === ".py" || ext === ".pyi") {
    const ruff = which("ruff");
    if (ruff) {
      const cfg = findUp(
        dir,
        ["ruff.toml", ".ruff.toml", "pyproject.toml"],
        stop,
      );
      // Prefer explicit ruff config; for pyproject require [tool.ruff]
      let cwd = dir;
      let use = false;
      if (cfg) {
        const base = path.basename(cfg);
        if (base === "ruff.toml" || base === ".ruff.toml") {
          use = true;
          cwd = path.dirname(cfg);
        } else {
          try {
            const txt = fs.readFileSync(cfg, "utf8");
            if (txt.includes("[tool.ruff")) {
              use = true;
              cwd = path.dirname(cfg);
            }
          } catch {
            /* */
          }
        }
      }
      if (use) {
        return {
          formatter: "ruff",
          argv: [ruff, "format", filePath],
          cwd,
        };
      }
    }
  }

  // gofmt
  if (ext === ".go") {
    const gofmt = which("gofmt");
    if (gofmt) {
      return { formatter: "gofmt", argv: [gofmt, "-w", filePath], cwd: dir };
    }
  }

  // rustfmt
  if (ext === ".rs") {
    const rustfmt = which("rustfmt");
    if (rustfmt) {
      return {
        formatter: "rustfmt",
        argv: [rustfmt, filePath],
        cwd: dir,
      };
    }
  }

  return null;
}

/**
 * Best-effort format after a successful write. Returns null when disabled or
 * no formatter applies. Never throws.
 */
export function maybeFormatAfterWrite(
  filePath: string,
  workspace: string,
): FormatResult | null {
  try {
    if (!isFormatOnWriteEnabled(workspace)) return null;
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const cmd = resolveFormatter(abs, path.resolve(workspace));
    if (!cmd) return null;
    const [bin, ...args] = cmd.argv;
    if (!bin) return null;
    const r = spawnSync(bin, args, {
      cwd: cmd.cwd || workspace,
      encoding: "utf8",
      timeout: 30_000,
      env: createChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) {
      return {
        formatter: cmd.formatter,
        ok: false,
        detail: r.error.message.slice(0, 200),
      };
    }
    if (typeof r.status === "number" && r.status !== 0) {
      const err = String(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 200);
      return { formatter: cmd.formatter, ok: false, detail: err };
    }
    return { formatter: cmd.formatter, ok: true };
  } catch (err) {
    return {
      formatter: "unknown",
      ok: false,
      detail: (err as Error).message?.slice(0, 200),
    };
  }
}

/** Append a short note to a tool success message when format ran. */
export function formatNoteSuffix(result: FormatResult | null): string {
  if (!result) return "";
  if (result.ok) return ` (formatted with ${result.formatter})`;
  return ` (format ${result.formatter} skipped: ${result.detail || "failed"})`;
}

/**
 * Best-effort: which formatters look available for this workspace
 * (for doctor tips). Never throws.
 */
export function detectProjectFormatters(workspace: string): string[] {
  const found: string[] = [];
  try {
    const ws = path.resolve(workspace || process.cwd());
    const pkgPath = findUp(ws, ["package.json"], ws);
    if (pkgPath) {
      const pkg = readJsonSafe(pkgPath);
      if (hasDep(pkg, "prettier") && (npmBin("prettier", ws) || which("prettier"))) {
        found.push("prettier");
      }
      if (hasDep(pkg, "@biomejs/biome") || hasDep(pkg, "biome")) {
        if (npmBin("biome", ws) || which("biome")) found.push("biome");
      }
    }
    if (findUp(ws, ["biome.json", "biome.jsonc"], ws)) {
      if (!found.includes("biome") && (npmBin("biome", ws) || which("biome"))) {
        found.push("biome");
      }
    }
    if (which("ruff") && findUp(ws, ["ruff.toml", ".ruff.toml"], ws)) {
      found.push("ruff");
    }
    if (which("gofmt")) found.push("gofmt");
    if (which("rustfmt")) found.push("rustfmt");
  } catch {
    /* */
  }
  return found;
}
