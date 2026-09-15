/**
 * Peer scout — a read-only harness sibling that researches 1–3 maintained
 * peers of this Identity's job while the mill executes.
 *
 * It is not a fourth cycle role. It writes `peers.md` (staged: named peers →
 * matching surfaces → candidates vs this tree) and sleeps. The next Planner
 * weighs the note after Looked:, like Serendipity:. The executor and the
 * Reviewer never see it. Fail-open: plan admission never waits.
 *
 * Kill-switch: FORGE_ULW_PEERS=0. Under node:test it stays off unless the
 * test sets FORGE_ULW_PEERS=1.
 */
import fs from "node:fs";
import path from "node:path";
import { isFalsy, isTruthy } from "../../util/bool.js";
import { envPositiveInt } from "../../util/env.js";
import { nowIso } from "../../util/fs.js";
import { detectProductKind } from "../../util/product-kind.js";
import {
  parsePeerScoutArtifact,
  peerScoutArtifactContract,
} from "./artifacts.js";
import { roleBody } from "./roles.js";
import {
  cycleActive,
  identitiesMatch,
  loadCycleState,
  peerScoutArtifactPath,
  adoptLiveControls,
  writeCycleState,
  type CycleState,
  type PeerScoutStage,
  type PeerScoutState,
} from "./state.js";
import type { CycleRuntime, RoleRunResult } from "./orchestrator.js";

const PEER_CLIP = 8_000;
const README_NAMES = ["README.md", "README", "readme.md", "Readme.md"] as const;

export function peerScoutEnabled(): boolean {
  if (isFalsy(process.env.FORGE_ULW_PEERS ?? "1")) return false;
  if (process.env.NODE_TEST_CONTEXT && !isTruthy(process.env.FORGE_ULW_PEERS)) {
    return false;
  }
  return true;
}

export function peerScoutStageTurns(): number {
  return envPositiveInt("FORGE_ULW_PEER_SCOUT_STAGE_TURNS", 0) || 8;
}

interface Job {
  abort: AbortController;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();

/** Test helper: wait until the fire-and-forget loop for this session settles. */
export function peerScoutFlush(sessionId: string): Promise<void> {
  return jobs.get(sessionId)?.done ?? Promise.resolve();
}

/** Test helper: drop in-flight jobs without writing sidecars. */
export function resetPeerScoutJobsForTest(): void {
  for (const job of jobs.values()) job.abort.abort();
  jobs.clear();
}

export function readPeerScoutArtifact(sessionId: string): string {
  if (!sessionId) return "";
  try {
    return fs.readFileSync(peerScoutArtifactPath(sessionId), "utf8");
  } catch {
    return "";
  }
}

export function clipPeerScoutForBrief(text: string): string {
  const t = (text || "").trim();
  if (t.length <= PEER_CLIP) return t;
  return `${t.slice(0, PEER_CLIP)}\n… [clipped ${t.length - PEER_CLIP} chars]`;
}

/**
 * Patch only the peerScout field. Live controls overlay first, then the
 * patch, then a write that does not re-overlay (or the patch would bounce).
 */
export function patchPeerScout(sessionId: string, patch: Partial<PeerScoutState>): void {
  const s = loadCycleState(sessionId);
  if (!s || s.legacy) return;
  adoptLiveControls(s);
  s.peerScout = {
    status: "idle",
    stage: 0,
    ...s.peerScout,
    ...patch,
    updatedAt: nowIso(),
  };
  writeCycleState(s);
}

export function formatPeerScoutStatus(s: CycleState | null | undefined): string {
  if (!s) return "";
  if (!peerScoutEnabled() && !s.peerScout) return "";
  const p = s.peerScout;
  if (!p || p.status === "off" || p.status === "idle") {
    if (!peerScoutEnabled()) return "Peer scout: off (FORGE_ULW_PEERS=0)";
    return "";
  }
  const peers = (p.peers ?? []).slice(0, 3).join(", ");
  const stage = `stage ${p.stage}`;
  if (p.status === "running") {
    return `Peer scout: ${stage}${peers ? ` · ${peers}` : ""} (background)`;
  }
  if (p.status === "sleeping") {
    return `Peer scout: ${stage}${peers ? ` · ${peers}` : ""} — sleeping`;
  }
  if (p.status === "error") {
    return `Peer scout: error${p.error ? ` — ${p.error}` : ""}`;
  }
  return "";
}

/** Dock chip: `peers 2` while running, `peers` while sleeping, omitted otherwise. */
export function formatPeerScoutDock(s: CycleState | null | undefined): {
  text: string;
  style: "yellow" | "magenta" | "dim";
} | null {
  if (!s?.peerScout) return null;
  const p = s.peerScout;
  if (p.status === "idle" || p.status === "off") return null;
  if (p.status === "error") return { text: "peers!", style: "yellow" };
  if (p.status === "running") {
    return { text: p.stage > 0 ? `peers ${p.stage}` : "peers", style: "yellow" };
  }
  if (p.status === "sleeping" && p.stage >= 1) {
    return { text: "peers", style: "magenta" };
  }
  return null;
}

/** `/cycle peers` card: status + the staged note, or why there is none. */
export function formatPeerScoutCard(s: CycleState | null | undefined): string {
  if (!s) return "Peer scout: ULW is off — /ulw [mandate] arms the plan-cycle driver.";
  if (!peerScoutEnabled()) {
    return "Peer scout: off (FORGE_ULW_PEERS=0). The mill does not research peers.";
  }
  const status = formatPeerScoutStatus(s) || "Peer scout: idle — it arms after a job hypothesis or Identity: exists.";
  const body = clipPeerScoutForBrief(readPeerScoutArtifact(s.sessionId));
  if (!body.trim()) {
    return [
      status,
      "",
      "No peers.md yet. The explorer writes it in the background during EXECUTE; /cycle status shows the stage. The next Planner weighs it after Looked:. The executor never sees it.",
    ].join("\n");
  }
  return [status, "", body].join("\n");
}

function shouldSleep(s: CycleState): boolean {
  const p = s.peerScout;
  if (!p || p.status !== "sleeping") return false;
  if ((p.stage ?? 0) < 3) return false;
  if (!s.identity) return true;
  return identitiesMatch(p.identityUsed, s.identity);
}

function shouldReaim(s: CycleState): boolean {
  const p = s.peerScout;
  if (!s.identity?.trim()) return false;
  if (!p?.identityUsed?.trim()) return false;
  return !identitiesMatch(p.identityUsed, s.identity);
}

/**
 * Fire-and-forget. Safe to call often: no-ops when sleeping on the same
 * Identity, or when a loop is already running for this session (unless
 * Identity changed — then abort and restart).
 */
export function ensurePeerScout(s: CycleState, rt: CycleRuntime): void {
  if (!peerScoutEnabled()) return;
  if (!s.sessionId || s.legacy || !cycleActive(s)) return;
  const disk = loadCycleState(s.sessionId) ?? s;
  if (shouldSleep(disk) && !shouldReaim(disk)) return;
  if (disk.peerScout?.status === "error" && !shouldReaim(disk)) return;

  const existing = jobs.get(s.sessionId);
  if (existing) {
    if (shouldReaim(disk)) {
      existing.abort.abort();
      const sid = s.sessionId;
      void existing.done.finally(() => {
        const cur = jobs.get(sid);
        if (cur?.abort === existing.abort) jobs.delete(sid);
        const next = loadCycleState(sid);
        if (next && cycleActive(next)) ensurePeerScout(next, rt);
      });
    }
    return;
  }

  const abort = new AbortController();
  const sid = s.sessionId;
  const done = runPeerScoutLoop(sid, rt, abort.signal).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    rt.log?.(`ULW peer scout: ${msg}`);
    try {
      patchPeerScout(sid, { status: "error", error: msg.slice(0, 200) });
    } catch {
      /* sidecar gone */
    }
  });
  jobs.set(sid, { abort, done });
  void done.finally(() => {
    const cur = jobs.get(sid);
    if (cur?.abort === abort) jobs.delete(sid);
  });
}

export async function stopPeerScout(sessionId: string, rt?: CycleRuntime): Promise<void> {
  const job = jobs.get(sessionId);
  if (job) {
    job.abort.abort();
    await job.done.catch(() => {});
    jobs.delete(sessionId);
  }
  const s = loadCycleState(sessionId);
  const child = s?.peerScout?.sessionId;
  if (child && rt?.cleanupRoleSession) {
    try {
      await rt.cleanupRoleSession(child);
    } catch {
      /* */
    }
  }
  if (s?.peerScout && s.peerScout.status === "running") {
    patchPeerScout(sessionId, { status: "idle", sessionId: undefined });
  }
}

async function runPeerScoutLoop(
  sessionId: string,
  rt: CycleRuntime,
  signal: AbortSignal,
): Promise<void> {
  let resumeId: string | undefined = loadCycleState(sessionId)?.peerScout?.sessionId;
  let retried = false;
  let tokens = 0;
  let steps = 0;

  while (!signal.aborted) {
    if (++steps > 6) {
      patchPeerScout(sessionId, {
        status: "error",
        error: "peer scout exceeded stage budget",
        tokens,
        sessionId: resumeId,
      });
      break;
    }
    const s = loadCycleState(sessionId);
    if (!s || !cycleActive(s)) break;

    if (shouldReaim(s) && resumeId) {
      if (rt.cleanupRoleSession) await rt.cleanupRoleSession(resumeId).catch(() => {});
      resumeId = undefined;
      retried = false;
    }

    const doneStage = (s.peerScout?.stage ?? 0) as PeerScoutStage;
    if (doneStage >= 3 && !shouldReaim(s)) {
      patchPeerScout(sessionId, {
        status: "sleeping",
        stage: 3,
        sessionId: undefined,
        identityUsed: s.identity || s.peerScout?.identityUsed,
      });
      if (resumeId && rt.cleanupRoleSession) {
        await rt.cleanupRoleSession(resumeId).catch(() => {});
      }
      break;
    }

    const target = (shouldReaim(s) ? 1 : Math.min(3, Math.max(1, doneStage + 1))) as 1 | 2 | 3;
    const job = (s.identity || "").trim() || jobHypothesis(rt.workspace);
    patchPeerScout(sessionId, {
      status: "running",
      stage: doneStage,
      identityUsed: s.identity || job,
      path: peerScoutArtifactPath(sessionId),
    });

    const brief = buildPeerScoutBrief({
      state: s,
      workspace: rt.workspace,
      target,
      previous: readPeerScoutArtifact(sessionId),
      job,
      reaim: shouldReaim(s),
    });

    const result: RoleRunResult = await rt.runRole("peer-scout", brief, {
      cycle: Math.max(1, s.cycle),
      keepSession: true,
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
      maxTurns: peerScoutStageTurns(),
      quiet: true,
      abort: signal,
    });
    tokens += (result.promptTokens || 0) + (result.completionTokens || 0);
    if (result.sessionId) resumeId = result.sessionId;

    if (signal.aborted) break;
    const live = loadCycleState(sessionId);
    if (!live || !cycleActive(live)) break;

    const parsed = parsePeerScoutArtifact(roleBody(result.text));
    if (!parsed) {
      if (!retried && result.ok) {
        retried = true;
        continue;
      }
      patchPeerScout(sessionId, {
        status: "error",
        error: (result.error || "peer scout produced no parseable Stage:").slice(0, 200),
        tokens,
        sessionId: resumeId,
      });
      break;
    }

    retried = false;
    const stage = Math.max(parsed.stage, target) as PeerScoutStage;
    writePeerScoutArtifact(sessionId, roleBody(result.text));
    snapshotPeerScoutIntoCycle(sessionId, Math.max(1, live.cycle));
    const sleeping = stage >= 3;
    patchPeerScout(sessionId, {
      status: sleeping ? "sleeping" : "running",
      stage,
      peers: parsed.peers,
      identityUsed: parsed.identityUsed || live.identity || job,
      path: peerScoutArtifactPath(sessionId),
      tokens,
      sessionId: sleeping ? undefined : resumeId,
      error: undefined,
    });
    rt.log?.(
      sleeping
        ? `ULW peer scout: stage 3 — sleeping (${(parsed.peers || []).join(", ") || "no peers"})`
        : `ULW peer scout: stage ${stage}${(parsed.peers || []).length ? ` · ${parsed.peers.join(", ")}` : ""}`,
    );
    if (sleeping) {
      if (resumeId && rt.cleanupRoleSession) {
        await rt.cleanupRoleSession(resumeId).catch(() => {});
      }
      break;
    }
  }
}

function writePeerScoutArtifact(sessionId: string, text: string): string {
  const file = peerScoutArtifactPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  return file;
}

function snapshotPeerScoutIntoCycle(sessionId: string, cycle: number): void {
  const src = peerScoutArtifactPath(sessionId);
  if (!fs.existsSync(src)) return;
  try {
    const dir = path.join(path.dirname(src), "cycles", String(cycle));
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, "peers.md");
    fs.copyFileSync(src, dst);
    try {
      fs.chmodSync(dst, 0o600);
    } catch {
      /* windows */
    }
  } catch {
    /* the run-level file is the mailbox */
  }
}

function readmeSnippet(workspace: string): string {
  if (!workspace) return "";
  for (const name of README_NAMES) {
    try {
      const raw = fs.readFileSync(path.join(workspace, name), "utf8");
      return raw.split("\n").slice(0, 24).join("\n").slice(0, 1200);
    } catch {
      /* next name */
    }
  }
  return "";
}

export function jobHypothesis(workspace: string): string {
  const kind = detectProductKind(workspace);
  const readme = readmeSnippet(workspace).replace(/\s+/g, " ").trim();
  const head = readme ? readme.slice(0, 360) : "unknown product";
  return `Hypothesis (${kind}): ${head}`;
}

export function buildPeerScoutBrief(input: {
  state: CycleState;
  workspace: string;
  target: 1 | 2 | 3;
  previous: string;
  job: string;
  reaim?: boolean;
}): string {
  const kind = detectProductKind(input.workspace);
  const lines: string[] = [
    `[Forge cycle peer scout — stage ${input.target} of 3]`,
    `You are the peer scout for an autonomous plan-cycle run. You do not implement. You do not write into the product tree. You research 1–3 maintained GitHub peers of THIS job and write a staged note the next Planner will weigh — evidence of the bar, not a backlog, not a feature checklist.`,
    `The executor never sees you. Do not address them. Do not invent items for this cycle.`,
    ``,
    `## Job`,
    input.job,
    `Product kind (from the tree, not the prompt): ${kind}`,
    input.state.mandate
      ? `Mandate (attention, not a spec): ${input.state.mandate}`
      : `Mandate: (none) — derive the job from the product.`,
    ``,
    `## This tree (read it so peer features do not look like gaps)`,
    input.workspace,
    ``,
    `## Tools`,
    `GitHub source is the github tool (action=search|repo|readme|contents|tree). For category discovery: action=search, sort=stars, a query for this job (not "best software"), prefer stars as a junk filter then recency — skip tutorials, awesome-lists, boilerplates, unmaintained 2019 trees, and a 80k-star repo that is the wrong job.`,
    `Follow up with action=readme then action=contents on the matching surface (--help, first-run, error/recovery, the verb). Do not scrape github.com HTML. Do not clone a zoo of repos. Depth is 1–3 peers, matching surface only.`,
    `web_search is allowed for "what a demanding user of this kind of product notices first" when you do not already know. Do not glob $HOME or the disk for forge-* files.`,
    ``,
    `## Stage ${input.target}`,
    input.reaim
      ? `Identity has locked (or changed). Previous peers may be the wrong job — re-name 1–3 peers of THIS Identity. Keep a previous peer only when it still does this job.`
      : "",
    input.target === 1
      ? `Name 1–3 peers that actually do this job. Stars are a junk filter, not a score. Write Stage: 1 and Peers:. Sat/Noticed/Candidates may be empty.`
      : input.target === 2
        ? `Sit the matching surface of each named peer via github readme/contents, and the matching surface of THIS tree. Write Stage: 2, keep Peers:, fill Sat: and Noticed:.`
        : `Compare those surfaces to THIS tree. Write Stage: 3. Candidates: are Considered: rows with leave it / Not for us: first-class. A candidate that is only in a peer and not visible in this tree is red now: unchecked — investigation, not a ship. Then stop.`,
    ``,
    input.previous.trim()
      ? `## Previous note (this run — revise, do not ignore)\n${clipPeerScoutForBrief(input.previous)}`
      : `## Previous note\n(none — this is the first stage)`,
    ``,
    `## Output`,
    `Your final message this turn is the peer-scout document and nothing else, in exactly this shape:`,
    peerScoutArtifactContract(),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Lines for the Planner scout (turn 1) and the single-brief fallback.
 * The run record is a different object — this is the category bar.
 * Empty when there is nothing to show; never a required labelled line.
 */
export function peerScoutBriefLines(s: CycleState): string[] {
  if (!peerScoutEnabled() && !s.peerScout) return [];
  const body = clipPeerScoutForBrief(readPeerScoutArtifact(s.sessionId));
  const running = s.peerScout?.status === "running";
  const lines: string[] = [];
  if (running && !body.trim()) {
    lines.push(
      `A peer scout is researching 1–3 maintained peers of this job in the background. Do not github-search the category; sit THIS product. Notes arrive on later scouts.`,
    );
    return lines;
  }
  if (!body.trim()) return lines;
  lines.push(
    ``,
    `## Category evidence (peer scout — read AFTER Looked:, do not let it replace the sit)`,
    `This is the bar, not a backlog. Competitors are context, not a feature checklist. A peer candidate becomes an item only if Looked: on THIS product can name the gap, or the item is an investigation (red now: unchecked — <why>). Not for us: and leave it are first-class. Do not github-search the category; the explorer already did.`,
    body,
  );
  if (running) {
    lines.push(
      `(The peer scout is still running — this is the latest stage, not the last.)`,
    );
  }
  return lines;
}
