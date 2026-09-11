#!/usr/bin/env node
/**
 * Put `forge` on PATH so `bash install.sh` is a reliable update.
 *
 * `npm link` alone fails closed on EACCES / EEXIST / a prefix that is not
 * first on PATH / a leftover global `forge` from another Node. We still try
 * it, then write a launcher that execs this clone's dist/cli.js. A foreign
 * `forge` (Foundry, …) is never overwritten — `forge-agent` is the alias.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_NAME = "forge-agent";
export const BIN_NAMES = ["forge", "forge-agent"];

export function repoRootFromHere(here = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(here)), "..");
}

export function cliPath(root) {
  return path.join(root, "dist", "cli.js");
}

export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function launcherSource(root, nodePath = process.execPath) {
  const cli = cliPath(root);
  return `#!/usr/bin/env bash
# Forge launcher — written by install.sh. Exec this clone, not a stale global.
NODE=${shQuote(nodePath)}
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "forge: Node.js 20+ not found on PATH. Re-run: bash install.sh" >&2
  exit 127
fi
exec "$NODE" ${shQuote(cli)} "$@"
`;
}

export function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function readHead(p, max = 8192) {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function resolvedCliRefs(text, binPath) {
  const out = [];
  const re =
    /(?:require\(|from |import\(|exec (?:\$NODE |node )?)['"]([^'"]*dist[/\\]cli\.js)['"]/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    out.push(path.isAbsolute(raw) ? raw : path.resolve(path.dirname(binPath), raw));
  }
  return out;
}

/** True when a bin file will run this repo's dist/cli.js. */
export function launcherPointsAtRepo(binPath, root) {
  const cli = realpathOrResolve(cliPath(root));
  const rootReal = realpathOrResolve(root);
  try {
    const binReal = fs.realpathSync(binPath);
    if (binReal === cli) return true;
    if (
      binReal.startsWith(rootReal + path.sep) &&
      /dist[/\\]cli\.js$/.test(binReal)
    ) {
      return true;
    }
  } catch {
    /* not a symlink to cli */
  }
  let text = "";
  try {
    const buf = readHead(binPath);
    if (buf.includes(0)) return false;
    text = buf.toString("utf8");
  } catch {
    return false;
  }
  if (text.includes(cli) || text.includes(cliPath(root))) return true;
  for (const ref of resolvedCliRefs(text, binPath)) {
    if (realpathOrResolve(ref) === cli) return true;
  }
  return false;
}

export function npmPrefixG() {
  const r = spawnSync("npm", ["prefix", "-g"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (r.status !== 0) {
    throw new Error(
      (r.stderr || r.stdout || r.error?.message || "npm prefix -g failed").trim(),
    );
  }
  return (r.stdout || "").trim();
}

export function npmRootG() {
  const r = spawnSync("npm", ["root", "-g"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (r.status !== 0) {
    throw new Error(
      (r.stderr || r.stdout || r.error?.message || "npm root -g failed").trim(),
    );
  }
  return (r.stdout || "").trim();
}

export function npmBinG(prefix = npmPrefixG()) {
  return path.join(prefix, "bin");
}

export function userBinDir(home = os.homedir()) {
  return path.join(home, ".local", "bin");
}

export function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function writeLauncher(dest, root, nodePath = process.execPath) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const st = fs.lstatSync(dest);
    if (st.isDirectory()) {
      throw new Error(`${dest} is a directory`);
    }
    // Unlink first so a symlink to dist/cli.js is not followed and clobbered.
    fs.unlinkSync(dest);
  } catch (err) {
    if (err && err.code !== "ENOENT" && !String(err.message).includes("is a directory")) {
      /* lstat/unlink race: rename below is the real write */
    } else if (err && String(err.message).includes("is a directory")) {
      throw err;
    }
  }
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, launcherSource(root, nodePath), { mode: 0o755 });
  fs.renameSync(tmp, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* win */
  }
}

export function listBinOnPath(
  name,
  pathEnv = process.env.PATH || "",
  pathSep = path.delimiter,
) {
  const out = [];
  const seen = new Set();
  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

export function listForgeOnPath(pathEnv, pathSep) {
  return listBinOnPath("forge", pathEnv, pathSep);
}

export function firstBinOnPath(name, pathEnv, pathSep) {
  return listBinOnPath(name, pathEnv, pathSep)[0] ?? null;
}

export function firstForgeOnPath(pathEnv, pathSep) {
  return firstBinOnPath("forge", pathEnv, pathSep);
}

export function looksLikeForgeAgentBin(binPath) {
  try {
    const st = fs.lstatSync(binPath);
    if (st.isSymbolicLink()) {
      let target = "";
      try {
        target = fs.readlinkSync(binPath);
      } catch {
        return false;
      }
      if (/forge-agent|dist[/\\]cli\.js|Forge launcher/.test(target)) return true;
      try {
        const real = fs.realpathSync(binPath);
        if (/forge-agent|dist[/\\]cli\.js/.test(real)) return true;
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
  let buf;
  try {
    buf = readHead(binPath);
  } catch {
    return false;
  }
  if (buf.includes(0)) return false;
  return /forge-agent|dist[/\\]cli\.js|Forge launcher/.test(buf.toString("utf8"));
}

export function canReplaceForgeBin(dest, root) {
  let st;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return true;
  }
  if (st.isDirectory()) return false;
  if (launcherPointsAtRepo(dest, root)) return true;
  return looksLikeForgeAgentBin(dest);
}

export function tryNpmUnlink(root) {
  const r = spawnSync("npm", ["unlink", "-g", PACKAGE_NAME], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    ok: r.status === 0,
    method: "npm unlink -g",
    detail: (r.stderr || r.stdout || "").trim().slice(0, 400),
  };
}

export function tryNpmLink(root) {
  const r = spawnSync("npm", ["link"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    ok: r.status === 0,
    method: "npm link",
    detail: (r.stderr || r.stdout || "").trim().slice(0, 800),
  };
}

export function tryNpmInstallG(root) {
  const r = spawnSync("npm", ["install", "-g", "."], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    ok: r.status === 0,
    method: "npm install -g .",
    detail: (r.stderr || r.stdout || "").trim().slice(0, 800),
  };
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function addLauncher(launchers, dest) {
  if (!launchers.includes(dest)) launchers.push(dest);
}

function pickBestBin(r) {
  if (r.pathPointsHere && r.forgeOnPath) return r.forgeOnPath;
  if (r.aliasOnPath && r.aliasPointsHere) return r.aliasOnPath;
  return r.launchers[0] ?? r.forgeOnPath ?? r.aliasOnPath ?? null;
}

export function linkForge(opts) {
  const root = path.resolve(opts.root);
  const cli = cliPath(root);
  const notes = [];
  const launchers = [];
  const nodePath = opts.nodePath || process.execPath;
  const pathSep = opts.pathSep || path.delimiter;

  if (!fs.existsSync(cli)) {
    return {
      ok: false,
      cli,
      launchers,
      forgeOnPath: null,
      aliasOnPath: null,
      pathPointsHere: false,
      aliasPointsHere: false,
      bestBin: null,
      npmLink: { ok: false, method: "npm link", detail: "dist/cli.js missing" },
      notes: [`Missing ${cli} — run npm run build first.`],
    };
  }
  try {
    fs.chmodSync(cli, 0o755);
  } catch {
    /* win / no-op */
  }

  let npmLink = { ok: false, method: "npm link", detail: "skipped" };
  let npmInstallG;
  if (!opts.skipNpm) {
    tryNpmUnlink(root);
    npmLink = tryNpmLink(root);
    if (!npmLink.ok) {
      notes.push(
        `npm link failed (${summarizeNpmErr(npmLink.detail)}). Trying npm install -g .`,
      );
      npmInstallG = tryNpmInstallG(root);
      if (!npmInstallG.ok) {
        notes.push(
          `npm install -g . failed (${summarizeNpmErr(npmInstallG.detail)}). Writing launchers only.`,
        );
      }
    }
  }

  const dirs = [];
  if (Array.isArray(opts.binDirs)) dirs.push(...opts.binDirs);
  if (!opts.skipNpmBin) {
    try {
      dirs.push(opts.npmBin || npmBinG());
    } catch (err) {
      notes.push(`Could not read npm prefix -g: ${err.message}`);
    }
  }
  if (!opts.skipUserBin) {
    dirs.push(userBinDir(opts.home));
  }

  for (const dir of unique(dirs)) {
    if (!dirWritable(dir)) {
      notes.push(`Not writable: ${dir}`);
      continue;
    }
    for (const name of BIN_NAMES) {
      const dest = path.join(dir, name);
      if (!canReplaceForgeBin(dest, root)) {
        notes.push(`Left existing ${dest} (not forge-agent).`);
        continue;
      }
      try {
        writeLauncher(dest, root, nodePath);
        addLauncher(launchers, dest);
      } catch (err) {
        notes.push(`Could not write ${dest}: ${err.message}`);
      }
    }
  }

  for (const name of BIN_NAMES) {
    const onPath = firstBinOnPath(name, opts.pathEnv, pathSep);
    if (
      onPath &&
      !launcherPointsAtRepo(onPath, root) &&
      canReplaceForgeBin(onPath, root) &&
      dirWritable(path.dirname(onPath))
    ) {
      try {
        writeLauncher(onPath, root, nodePath);
        addLauncher(launchers, onPath);
        notes.push(`Replaced stale PATH ${name} at ${onPath} with this clone.`);
      } catch (err) {
        notes.push(`PATH ${name} ${onPath} is stale and not writable: ${err.message}`);
      }
    }
  }

  const forgeOnPath = firstBinOnPath("forge", opts.pathEnv, pathSep);
  const aliasOnPath = firstBinOnPath("forge-agent", opts.pathEnv, pathSep);
  const pathPointsHere = forgeOnPath
    ? launcherPointsAtRepo(forgeOnPath, root)
    : false;
  const aliasPointsHere = aliasOnPath
    ? launcherPointsAtRepo(aliasOnPath, root)
    : false;

  if (forgeOnPath && !pathPointsHere) {
    notes.push(
      `PATH's forge is ${forgeOnPath} (not this clone). hash -r  ·  or move this launcher earlier on PATH. If that binary is another tool (Foundry), use forge-agent.`,
    );
  }
  if (!forgeOnPath && !aliasOnPath && launchers.length) {
    const dir = path.dirname(launchers[launchers.length - 1]);
    notes.push(
      `Wrote ${launchers[launchers.length - 1]} but that directory is not on PATH. Add: export PATH="${dir}:$PATH"`,
    );
  }

  const ok = launchers.some((p) => launcherPointsAtRepo(p, root));
  const result = {
    ok,
    cli,
    launchers,
    forgeOnPath,
    aliasOnPath,
    pathPointsHere,
    aliasPointsHere,
    bestBin: null,
    npmLink,
    npmInstallG,
    notes,
  };
  result.bestBin = pickBestBin(result);
  return result;
}

function summarizeNpmErr(detail) {
  const d = detail || "unknown";
  if (/EACCES|permission denied/i.test(d)) return "EACCES — prefix not writable";
  if (/EEXIST/i.test(d)) return "EEXIST";
  if (/EPERM/i.test(d)) return "EPERM";
  return d.split("\n").filter(Boolean).slice(-2).join(" · ").slice(0, 160);
}

export function formatLinkReport(r) {
  const lines = [];
  lines.push(`cli: ${r.cli}`);
  if (r.npmLink.ok) lines.push("npm link: ok");
  else lines.push("npm link: skipped/failed");
  if (r.npmInstallG?.ok) lines.push("npm install -g .: ok");
  for (const p of r.launchers) lines.push(`launcher: ${p}`);
  if (r.forgeOnPath) {
    lines.push(
      r.pathPointsHere
        ? `PATH forge: ${r.forgeOnPath} (this clone)`
        : `PATH forge: ${r.forgeOnPath} (NOT this clone)`,
    );
  } else {
    lines.push("PATH forge: not found");
  }
  if (r.aliasOnPath) {
    lines.push(
      r.aliasPointsHere
        ? `PATH forge-agent: ${r.aliasOnPath} (this clone)`
        : `PATH forge-agent: ${r.aliasOnPath} (NOT this clone)`,
    );
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  if (r.bestBin) lines.push(`FORGE_BIN=${r.bestBin}`);
  return lines.join("\n");
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

function main() {
  const root = repoRootFromHere();
  const r = linkForge({
    root,
    nodePath: process.env.FORGE_NODE || process.execPath,
  });
  console.log(formatLinkReport(r));
  if (!r.ok) {
    console.error(
      "Forge is built but not on PATH. Run the printed export PATH=… or fix npm's global prefix.",
    );
    process.exit(1);
  }
}

if (isMain()) main();
