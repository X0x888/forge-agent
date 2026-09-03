import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, saveSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  sessionToSnapshot,
  collectSnapshots,
} from "../src/statusline/snapshot.js";
import {
  renderHud,
  renderTmux,
  renderCompactStrip,
  snapshotsToJson,
} from "../src/statusline/render.js";
import {
  heartbeatSession,
  computeLiveness,
  releaseSession,
  loadActiveRegistry,
} from "../src/statusline/active.js";
import {
  beginTurn,
  endTurn,
  setPhase,
  _resetActivityForTests,
} from "../src/statusline/activity.js";
import {
  collectPlanUsage,
  parseXaiBillingBody,
} from "../src/statusline/plan.js";
import {
  formatPlan,
  resetCountdown,
} from "../src/statusline/render.js";
import {
  startBackgroundTask,
  _resetTasksForTests,
  listTasks,
} from "../src/agent/tools/background-tasks.js";
import {
  buildPromptFlags,
  buildIdlePrompt,
  buildLivePrompt,
  renderBusyStatusLine,
  renderTurnFooter,
  formatSessionDetails,
  renderLiveRunHeader,
  formatBackgroundTasksList,
  formatIdleBgCompletionNotice,
  createWorkingIndicator,
  shouldRedockLiveOnPhase,
  formatLiveControlFeedback,
} from "../src/tui/status-bar.js";
import {
  renderBottomStatusLine,
  createBottomStatusDock,
  formatDockActivity,
} from "../src/tui/bottom-status.js";
import { clipAnsi, visibleWidth } from "../src/util/format.js";
import type { ForgeConfig } from "../src/config/types.js";
import type { ResolvedAuth } from "../src/auth/types.js";
import { armUlwCycle } from "../src/harness/ulw-cycle.js";

describe("statusline", () => {
  beforeEach(() => {
    _resetActivityForTests();
    _resetTasksForTests();
  });

  it("builds snapshot and renders without plan inventing numbers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "anthropic", model: "claude-sonnet-4" });
    s.messages.push({ role: "user", content: "hello world ".repeat(50) });
    s.meta.totalPromptTokens = 1200;
    s.meta.totalCompletionTokens = 400;
    s.meta.ultrawork = true;
    saveSession(s);

    const snap = sessionToSnapshot(s, {
      windowTokens: 100_000,
      authMethod: "api_key",
      authLabel: "env:ANTHROPIC_API_KEY",
    });
    assert.equal(snap.provider, "anthropic");
    assert.ok(snap.context.percent >= 0);
    assert.equal(snap.tokens.totalTokens, 1600);
    assert.ok(snap.tags.includes("ULW"));

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /anthropic/);
    assert.match(hud, /ctx:|█|░|%/i);
    assert.match(hud, /tok:/);

    const tmux = renderTmux(snap);
    assert.match(tmux, /forge/);
    assert.match(tmux, /ctx:/);

    const strip = renderCompactStrip(snap, { plain: true, width: 100 });
    assert.match(strip, /%/);

    const j = JSON.parse(snapshotsToJson([snap]));
    assert.equal(j.ok, true);
    assert.ok(typeof j.version === "string" && j.version.length > 0);
    assert.equal(j.count, 1);
    assert.equal(j.sessions.length, 1);
  });

  it("surfaces foreign live session locks in snapshot + HUD", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-lock-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    saveSession(s);
    const { acquireSessionLock, releaseSessionLock } = await import(
      "../src/session/lock.js"
    );
    // Simulate another process holding the lock
    const lockPath = path.join(tmp, "sessions", s.meta.id, "session.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid + 99999,
        hostname: "other-host",
        acquiredAt: new Date().toISOString(),
        sessionId: s.meta.id,
      }) + "\n",
    );
    // pidAlive will be false for fake pid — force alive by using our pid but
    // mark as foreign via hostname only works if pid differs; use dead pid → no LOCK tag.
    // Instead acquire for real then rewrite pid field to a live foreign pid is hard.
    // Use acquire (mine) then assert lock.mine; then write foreign dead lock for tag absence.
    releaseSessionLock(s.meta.id);
    const mine = acquireSessionLock(s.meta.id);
    assert.equal(mine.ok, true);
    let snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.lock);
    assert.equal(snap.lock!.mine, true);
    assert.equal(snap.lock!.pid, process.pid);
    releaseSessionLock(s.meta.id);

    // Foreign lock with current pid on different "logical" holder: use pid 1 if alive
    const foreignPid = 1;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: foreignPid,
        hostname: "ci-runner",
        acquiredAt: new Date().toISOString(),
        sessionId: s.meta.id,
      }) + "\n",
    );
    snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.lock);
    assert.equal(snap.lock!.mine, false);
    if (snap.lock!.alive) {
      assert.ok(snap.tags.some((t) => t.startsWith("LOCK:")));
      const hud = renderHud([snap], { plain: true, width: 140 });
      assert.match(hud, /LOCK:|lock:pid/i);
      const strip = renderCompactStrip(snap, { plain: true, width: 120 });
      assert.match(strip, /LOCK:/);
    }
  });

  it("tracks live heartbeat", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl2-"));
    process.env.FORGE_HOME = tmp;
    heartbeatSession({
      sessionId: "abc-123",
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    const { liveness } = computeLiveness("abc-123", new Date().toISOString());
    assert.equal(liveness, "live");
    releaseSession("abc-123");
  });

  it("reports working when busy heartbeat is set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-work-"));
    process.env.FORGE_HOME = tmp;
    heartbeatSession({
      sessionId: "work-1",
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      busy: true,
      phase: "tool",
      phaseDetail: "bash }",
    });
    const { liveness } = computeLiveness("work-1", new Date().toISOString());
    assert.equal(liveness, "working");
    heartbeatSession({
      sessionId: "work-1",
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      busy: false,
      phase: "idle",
    });
    const e = loadActiveRegistry().sessions["work-1"];
    assert.equal(e?.phase, "idle");
    assert.equal(e?.phaseDetail, undefined);
    releaseSession("work-1");
  });

  it("snapshot includes activity when mid-turn in this process", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-act-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    saveSession(s);
    heartbeatSession({
      sessionId: s.meta.id,
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    beginTurn();
    setPhase("tool", "bash npm test");
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.activity?.busy);
    assert.equal(snap.activity?.phase, "tool");
    assert.match(snap.activity?.detail || "", /bash/);
    assert.equal(snap.liveness, "working");

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /tool:|thinking|working/i);

    endTurn();
    releaseSession(s.meta.id);
  });

  it("renders background tasks in HUD", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-bg-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    saveSession(s);
    heartbeatSession({
      sessionId: s.meta.id,
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });

    const started = await startBackgroundTask({
      command: "sleep 30",
      cwd: tmp,
      profile: "off",
      missingBackend: "fallback",
    });
    assert.equal(started.ok, true);
    assert.ok(listTasks().some((t) => t.status === "running"));

    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok((snap.activity?.bgRunning ?? 0) >= 1);
    assert.ok(snap.backgroundTasks?.some((t) => t.status === "running"));

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /bg:|sleep/);

    const list = formatBackgroundTasksList();
    assert.match(list, /sleep|running/i);

    _resetTasksForTests();
    endTurn();
    releaseSession(s.meta.id);
  });

  it("idle bg completion notice keeps fail/exit and /tasks", () => {
    const line = formatIdleBgCompletionNotice([
      {
        id: "bg_abc123_xyz",
        command: "npm test -- tests/long-name.test.ts",
        status: "failed",
        exitCode: 1,
      },
      {
        id: "bg_def456_uvw",
        command: "sleep 1",
        status: "completed",
        exitCode: 0,
      },
    ]);
    assert.match(line, /fail/);
    assert.match(line, /exit=1/);
    assert.match(line, /done/);
    assert.match(line, /\/tasks/);
    const withTail = formatIdleBgCompletionNotice([
      {
        id: "bg_abc123_xyz",
        command: "npm test",
        status: "completed",
        exitCode: 0,
        lastLine: "ℹ pass 36",
      },
    ]);
    assert.match(withTail, /pass 36/);
    assert.doesNotMatch(withTail, /\n/);
    assert.equal(formatIdleBgCompletionNotice([]), "");
  });

  it("pauses dock paints so Allow?/ask_user is not clobbered", () => {
    const writes: string[] = [];
    const dock = createBottomStatusDock({
      getContext: () => ({
        config: { ...DEFAULT_CONFIG, model: "grok-4", contextWindow: 128_000 },
        session: createSession({
          cwd: "/tmp",
          provider: "xai",
          model: "grok-4",
        }),
        auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
      }),
      forceEnabled: true,
      paintIntervalMs: 0,
      planIntervalMs: 0,
      write: (s) => writes.push(s),
    });
    dock.start();
    const afterStart = writes.length;
    assert.ok(afterStart > 0, "start paints the dock");
    dock.pause();
    assert.equal(dock.pauseDepth(), 1);
    dock.refresh();
    dock.setPlan(undefined);
    assert.equal(writes.length, afterStart, "paused dock must not paint");
    dock.pause();
    dock.resume();
    assert.equal(dock.pauseDepth(), 1);
    assert.equal(writes.length, afterStart, "nested pause still silent");
    dock.resume();
    assert.equal(dock.pauseDepth(), 0);
    assert.ok(writes.length > afterStart, "resume paints once");
    dock.stop();
  });

  it("prompt flags and turn footer surface session health", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-prompt-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.meta.ultrawork = true;
    s.meta.totalPromptTokens = 500;
    s.meta.totalCompletionTokens = 100;
    s.todos = [
      { id: "1", content: "ship", status: "in_progress" },
    ];
    saveSession(s);

    armUlwCycle(s.meta.id, "improve", { cycle: 1, maxWaves: 2 });

    const config = {
      provider: "xai",
      model: "grok-4",
      contextWindow: 128_000,
      permissionMode: "default",
      blockingStopHooks: true,
    } as ForgeConfig;
    const auth = {
      provider: "xai",
      method: "api_key",
      token: "test",
    } as ResolvedAuth;

    const prevCols = process.stdout.columns;
    const prevTty = process.stdout.isTTY;
    const prevDock = process.env.FORGE_BOTTOM_STATUS;
    // Wide enough that footer clipping does not drop ULW controls / verify tips.
    Object.defineProperty(process.stdout, "columns", {
      value: 200,
      configurable: true,
    });
    process.env.FORGE_BOTTOM_STATUS = "0";
    try {
      const flags = buildPromptFlags({ config, session: s, auth });
      assert.match(flags, /ULW/);
      assert.match(flags, /c=1/);
      assert.match(flags, /w=0\/2/);
      const snapTags = sessionToSnapshot(s, { authMethod: "api_key" }).tags;
      assert.ok(snapTags.includes("w=0/2"), "HUD shows current/cap, not just mw=");
      assert.ok(!snapTags.some((t) => t.startsWith("mw=")));
      // No last-verify yet → no bare ✓ flag
      assert.doesNotMatch(flags.replace(/\x1b\[[0-9;]*m/g, ""), /✓/);
      assert.doesNotMatch(flags, /VERBOSE/);
      assert.match(
        buildPromptFlags({ config, session: s, auth, verbose: true }),
        /VERBOSE/,
      );

      const footer = renderTurnFooter(
        { config, session: s, auth },
        { promptTokens: 100, completionTokens: 50, stopContinues: 1 },
      );
      assert.match(footer, /ctx/);
      assert.match(footer, /▶ ship/);
      assert.match(footer, /harness/);
      assert.match(footer, /ULW c=1 w=0/);
      assert.doesNotMatch(footer, /\/cycle 0/);

      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });
      delete process.env.FORGE_BOTTOM_STATUS;
      const slim = renderTurnFooter(
        { config, session: s, auth },
        { promptTokens: 100, completionTokens: 50, stopContinues: 1 },
      );
      assert.match(slim, /turn in=/);
      assert.match(slim, /harness/);
      assert.doesNotMatch(slim, /ctx /);
      assert.doesNotMatch(slim, /▶ ship/);
      assert.doesNotMatch(slim, /ULW /);
      assert.doesNotMatch(slim, /\/cycle 0/);
      process.env.FORGE_BOTTOM_STATUS = "0";

      // After edits, footer surfaces cheapest project check (when package.json exists).
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
      );
      fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
      s.meta.editCount = 2;
      s.meta.cwd = tmp;
      const footer2 = renderTurnFooter(
        {
          config: { ...config, workspace: tmp },
          session: s,
          auth,
        },
        { promptTokens: 100, completionTokens: 50 },
      );
      // Strip ANSI for assertion (chalk may wrap the check tip).
      const plain = footer2.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain, /next npm run typecheck|next npm test/);
      assert.doesNotMatch(plain, /✓ npm /);

      // When a structural check was recorded, prefer last✓ over preferred tip.
      s.meta.lastVerificationCommand = "npm test";
      s.meta.lastVerificationAt = "2026-04-10T12:34:56.000Z";
      const flags2 = buildPromptFlags({ config, session: s, auth });
      assert.match(flags2.replace(/\x1b\[[0-9;]*m/g, ""), /✓/);
      const footer3 = renderTurnFooter(
        {
          config: { ...config, workspace: tmp },
          session: s,
          auth,
        },
        { promptTokens: 100, completionTokens: 50 },
      );
      const plain3 = footer3.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain3, /last✓ npm test/);

      // Δ closer owns proof — footer must not reprint last✓ / next.
      const omitted = renderTurnFooter(
        {
          config: { ...config, workspace: tmp },
          session: s,
          auth,
        },
        { promptTokens: 100, completionTokens: 50 },
        { omitProof: true },
      );
      const omittedPlain = omitted.replace(/\x1b\[[0-9;]*m/g, "");
      assert.doesNotMatch(omittedPlain, /last✓/);
      assert.doesNotMatch(omittedPlain, /next /);
      assert.match(omittedPlain, /turn in=/);
    } finally {
      if (prevDock === undefined) delete process.env.FORGE_BOTTOM_STATUS;
      else process.env.FORGE_BOTTOM_STATUS = prevDock;
      Object.defineProperty(process.stdout, "isTTY", {
        value: prevTty,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "columns", {
        value: prevCols,
        configurable: true,
      });
    }
  });

  it("plan adapter is honest for api_key and copilot", async () => {
    const api = await collectPlanUsage({ provider: "anthropic", authMethod: "api_key" });
    assert.ok(api?.note);
    assert.equal(api?.percent, undefined);

    const copilot = await collectPlanUsage({
      provider: "copilot",
      authMethod: "subscription",
    });
    assert.ok(copilot?.note?.toLowerCase().includes("quota") || copilot?.product);
    assert.equal(copilot?.percent, undefined);

    const cursor = await collectPlanUsage({
      provider: "cursor",
      authMethod: "subscription",
    });
    assert.equal(cursor?.product, "Cursor");
    assert.equal(cursor?.percent, undefined);
  });

  it("parses nested SuperGrok format=credits billing body", () => {
    const end = new Date(Date.now() + 3 * 86400_000).toISOString();
    const plan = parseXaiBillingBody(
      {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-05T18:23:30.013898+00:00",
            end,
          },
          creditUsagePercent: 22.0,
          productUsage: [
            { product: "GrokBuild", usagePercent: 22.0 },
            { product: "GrokChat" },
          ],
          billingPeriodStart: "2026-08-05T18:23:30.013898+00:00",
          billingPeriodEnd: end,
        },
      },
      "test:credits",
    );
    assert.equal(plan.percent, 22);
    assert.equal(plan.periodLabel, "week");
    assert.equal(plan.resetsAt, end);
    assert.match(plan.product || "", /SuperGrok|Build/i);

    const rendered = formatPlan(plan, false);
    assert.ok(rendered, "formatPlan must surface use%");
    assert.match(rendered!, /use:22%/);
    assert.match(rendered!, /reset /);
    // Bare "week" alone was the broken-cache failure mode
    assert.notEqual(rendered!.trim(), "week");
  });

  it("parses plain /v1/billing used/limit {val} wrappers", () => {
    const end = "2026-09-01T00:00:00+00:00";
    const plan = parseXaiBillingBody(
      {
        config: {
          monthlyLimit: { val: 150000 },
          used: { val: 27795 },
          billingPeriodStart: "2026-08-01T00:00:00+00:00",
          billingPeriodEnd: end,
        },
      },
      "test:plain",
    );
    assert.equal(plan.used, 27795);
    assert.equal(plan.limit, 150000);
    assert.equal(plan.percent, 19); // round(27795/150000*100)
    assert.equal(plan.resetsAt, end);
    const rendered = formatPlan(plan, false)!;
    assert.match(rendered, /use:19%/);
    assert.match(rendered, /28k\/150k/);
  });

  it("drops SuperGrok remaining=0 / limit=0 residue next to a live weekly %", () => {
    const plan = parseXaiBillingBody(
      {
        config: {
          creditUsagePercent: 1.2,
          remaining: 0,
          monthlyLimit: 0,
          used: 645,
        },
      },
      "test:credits-stub",
    );
    assert.equal(plan.percent, 1);
    assert.equal(plan.used, 645);
    assert.equal(plan.limit, undefined);
    assert.equal(plan.remaining, undefined);
  });

  it("keeps remaining=0 when it is a spent budget against a real cap", () => {
    const plan = parseXaiBillingBody(
      { used: 100, limit: 100 },
      "test:spent-cap",
    );
    assert.equal(plan.percent, 100);
    assert.equal(plan.limit, 100);
    assert.equal(plan.remaining, 0);
  });

  it("keeps remaining=0 for remaining-only bodies (no percent)", () => {
    const plan = parseXaiBillingBody({ remaining: 0 }, "test:remaining-only");
    assert.equal(plan.percent, undefined);
    assert.equal(plan.remaining, 0);
  });

  it("still accepts flat legacy billing shapes", () => {
    const plan = parseXaiBillingBody(
      { used: 10, limit: 100, period_end: "2099-01-01T00:00:00Z" },
      "test:flat",
    );
    assert.equal(plan.percent, 10);
    assert.equal(plan.used, 10);
    assert.equal(plan.limit, 100);
    assert.equal(plan.resetsAt, "2099-01-01T00:00:00Z");
  });

  it("formatPlan hides empty week-only plan (broken parse residue)", () => {
    const empty = formatPlan(
      {
        unit: "credits",
        periodLabel: "week",
        product: "SuperGrok",
        source: "xai:cli-chat-proxy/billing",
      },
      false,
    );
    assert.equal(empty, null);
  });

  it("resetCountdown formats multi-day windows", () => {
    const iso = new Date(Date.now() + 3 * 86400_000 + 2 * 3600_000).toISOString();
    const s = resetCountdown(iso);
    assert.ok(s);
    assert.match(s!, /reset 3d2h|reset 3d/);
  });

  it("bottom status line includes model + plan quota + reset", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-bottom-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.5" });
    const end = new Date(Date.now() + 2 * 86400_000).toISOString();
    const config = { ...DEFAULT_CONFIG, provider: "xai", model: "grok-4.5", contextWindow: 500_000 } as ForgeConfig;
    const auth: ResolvedAuth = {
      provider: "xai",
      method: "subscription",
      token: "t",
      accountId: "xai:test",
      accountLabel: "sub:test@example.com",
    };
    const line = renderBottomStatusLine(
      { config, session: s, auth },
      {
        percent: 22,
        used: 27795,
        limit: 150000,
        remaining: 122205,
        unit: "credits",
        periodLabel: "week",
        resetsAt: end,
        product: "SuperGrok",
        source: "test",
      },
      { width: 120, plain: true },
    );
    assert.match(line, /forge/);
    assert.match(line, /xai\/grok-4\.5/);
    assert.match(line, /use:22%/);
    assert.match(line, /reset /);
    assert.match(line, /ctx /);
  });

  it("dock paints last-round cache ratio after 8k prompt", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-cache-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    s.meta.totalPromptTokens = 200_000;
    s.meta.totalCacheReadTokens = 80_000;
    s.meta.lastRoundPromptTokens = 40_000;
    s.meta.lastRoundCacheReadTokens = 39_600;
    const snap = sessionToSnapshot(s, { windowTokens: 500_000 });
    assert.ok(snap.tokens.cacheRatio != null);
    assert.ok(Math.abs((snap.tokens.cacheRatio ?? 0) - 0.99) < 0.01);
    assert.equal(snap.tokens.cacheRatioLive, true);
    const hud = renderHud([snap], { plain: true, width: 160 });
    assert.match(hud, /cache 99%/);
    const config = {
      ...DEFAULT_CONFIG,
      provider: "xai",
      model: "grok-4.6",
      contextWindow: 500_000,
    } as ForgeConfig;
    const auth: ResolvedAuth = {
      provider: "xai",
      method: "subscription",
      token: "t",
      accountId: "xai:test",
      accountLabel: "sub:test@example.com",
    };
    const line = renderBottomStatusLine(
      { config, session: s, auth },
      undefined,
      { width: 160, plain: true },
    );
    assert.match(line, /cache 99%/);
  });

  it("dock paints live session spend from token totals", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-cost-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    s.meta.totalPromptTokens = 2_000_000;
    s.meta.totalCompletionTokens = 100_000;
    s.meta.totalCacheReadTokens = 1_800_000;
    const config = {
      ...DEFAULT_CONFIG,
      provider: "xai",
      model: "grok-4.6",
      contextWindow: 500_000,
    } as ForgeConfig;
    const auth: ResolvedAuth = {
      provider: "xai",
      method: "api_key",
      token: "t",
      accountId: "xai:test",
    };
    const line = renderBottomStatusLine(
      { config, session: s, auth },
      undefined,
      { width: 160, plain: true },
    );
    assert.match(line, /~\$/);
  });

  it("dock ctx follows last API prompt_tokens when the estimate is lower", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-api-ctx-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    s.meta.lastRoundPromptTokens = 201_333;
    const snap = sessionToSnapshot(s, { windowTokens: 500_000 });
    assert.ok(snap.context.usedTokens >= 201_333);
    assert.equal(snap.context.source, "session_api");
  });

  it("narrow dock drops brand before ULW/YOLO/budget", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-dock-narrow-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    s.meta.ultrawork = true;
    s.meta.totalPromptTokens = 80_000;
    s.meta.totalCompletionTokens = 20_000;
    const config = {
      ...DEFAULT_CONFIG,
      provider: "xai",
      model: "grok-4.6",
      contextWindow: 500_000,
      permissionMode: "bypassPermissions",
      maxCostUsd: 2,
    } as ForgeConfig;
    const auth: ResolvedAuth = {
      provider: "xai",
      method: "subscription",
      token: "t",
      accountId: "xai:test",
      accountLabel: "sub:test@example.com",
    };
    const line = renderBottomStatusLine(
      { config, session: s, auth },
      undefined,
      { width: 48, plain: true },
    );
    assert.match(line, /ULW/);
    assert.match(line, /YOLO/);
    assert.match(line, /budget|ctx /);
    assert.doesNotMatch(line, /⚒/);
  });

  it("formatDockActivity shows tool detail + phase elapsed, not the word tool", () => {
    assert.equal(
      formatDockActivity({
        busy: false,
        phase: "idle",
        phaseStartedAt: Date.now(),
      }),
      undefined,
    );
    assert.equal(
      formatDockActivity({
        busy: true,
        phase: "tool",
        detail: "bash npm test",
        phaseStartedAt: Date.now(),
      }),
      "bash npm test",
    );
    const started = Date.now() - 12_400;
    assert.equal(
      formatDockActivity(
        {
          busy: true,
          phase: "tool",
          detail: "bash npm test",
          phaseStartedAt: started,
        },
        { now: started + 12_400 },
      ),
      "bash npm test · 12s",
    );
    assert.equal(
      formatDockActivity(
        {
          busy: true,
          phase: "tool",
          detail: "bash npm test --coverage --reporter spec src/tui",
          phaseStartedAt: Date.now(),
        },
        { max: 18 },
      ),
      "bash npm test --c…",
    );
    assert.equal(
      formatDockActivity({
        busy: true,
        phase: "waiting",
        detail: "retry 2/3: 429",
        phaseStartedAt: Date.now(),
      }),
      "wait retry 2/3: 429",
    );
    const thinkAt = 1_700_000_000_000;
    assert.equal(
      formatDockActivity(
        {
          busy: true,
          phase: "thinking",
          phaseStartedAt: thinkAt,
        },
        { now: thinkAt + 90_000 },
      ),
      "think · 1m30s",
    );
  });

  it("dock paints running tool instead of the word tool", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-dock-tool-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const config = {
      ...DEFAULT_CONFIG,
      provider: "xai",
      model: "grok-4.6",
      contextWindow: 500_000,
    } as ForgeConfig;
    const auth: ResolvedAuth = {
      provider: "xai",
      method: "subscription",
      token: "t",
      accountId: "xai:test",
      accountLabel: "sub:test@example.com",
    };
    beginTurn();
    setPhase("tool", "bash npm test");
    const line = renderBottomStatusLine(
      { config, session: s, auth },
      undefined,
      { width: 160, plain: true },
    );
    assert.match(line, /bash npm test/);
    assert.doesNotMatch(line, /(?<![a-z])tool(?![a-z])/);
    endTurn();
  });

  it("hides N/A plan noise in render", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl3-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "openai", model: "gpt-4.1" });
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    snap.plan = {
      source: "openai:api_key",
      note: "API key — billed per token; see session cost estimate",
      product: "OpenAI API",
    };
    const hud = renderHud([snap], { plain: true, width: 100 });
    assert.doesNotMatch(hud, /billed per token/);
  });

  it("working indicator pause is refcounted", () => {
    const w = createWorkingIndicator();
    w.start();
    assert.equal(w.pauseDepth(), 0);
    w.pause();
    w.pause();
    assert.equal(w.pauseDepth(), 2);
    w.resume();
    assert.equal(w.pauseDepth(), 1);
    w.resume();
    assert.equal(w.pauseDepth(), 0);
    w.stop();

    const colored = "\x1b[32mhello\x1b[0m world";
    assert.equal(visibleWidth(colored), "hello world".length);
    const clipped = clipAnsi(colored, 5);
    assert.ok(visibleWidth(clipped) <= 5);
    // Colour that was opened still gets closed.
    assert.ok(clipped.endsWith("\x1b[0m"));
    // …but clipping plain text used to graft a reset onto it, so a clipped
    // session title or `/help` row carried an escape under NO_COLOR and in
    // every other plain path. Close only what was opened.
    assert.equal(clipAnsi("hello world", 5), "hello");
    assert.equal(clipAnsi("hello world", 99), "hello world");
  });

  it("parallel tool hold stays until all pending settle", () => {
    // Mirrors REPL contract: pendingTools++ on phase tool, -- on settled
    const w = createWorkingIndicator();
    w.start();
    let pending = 0;
    let toolHold = false;
    const setToolHold = (on: boolean) => {
      if (on && !toolHold) {
        w.pause();
        toolHold = true;
      } else if (!on && toolHold) {
        w.resume();
        toolHold = false;
      }
    };
    const onPhaseTool = () => {
      pending += 1;
      setToolHold(true);
    };
    const onSettled = () => {
      pending = Math.max(0, pending - 1);
      if (pending === 0) setToolHold(false);
    };

    // A and B enter tool phase (A still in permission)
    onPhaseTool();
    onPhaseTool();
    assert.equal(pending, 2);
    assert.equal(w.pauseDepth(), 1);
    // B finishes while A still waiting
    onSettled();
    assert.equal(pending, 1);
    assert.equal(w.pauseDepth(), 1); // still held for A
    // A finishes
    onSettled();
    assert.equal(pending, 0);
    assert.equal(w.pauseDepth(), 0);
    w.stop();
  });

  it("collectSnapshots --cwd uses native listSessions filter before limit", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-cwd-"));
    process.env.FORGE_HOME = tmp;
    const a = path.join(tmp, "proj-a");
    const b = path.join(tmp, "proj-b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    // Flood other workspace so a post-limit filter would miss proj-a
    for (let i = 0; i < 25; i++) {
      createSession({ cwd: b, provider: "xai", model: "m" });
    }
    const target = createSession({ cwd: a, provider: "xai", model: "m" });
    target.meta.title = "status-cwd-hit";
    saveSession(target);

    const snaps = await collectSnapshots({
      cwd: a,
      all: true,
      fetchPlan: false,
    });
    assert.ok(snaps.length >= 1);
    assert.ok(
      snaps.every((s) => path.resolve(s.cwd) === path.resolve(a)),
      "all snapshots should be for cwd filter",
    );
    assert.ok(
      snaps.some((s) => s.sessionId === target.meta.id),
      "same-cwd session must not be starved by other workspaces",
    );
  });
});

describe("statusline PIN badge", () => {
  it("tags pinned sessions with PIN", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-pin-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession, setSessionPinned } = await import(
      "../src/session/session.js"
    );
    const { collectSnapshots } = await import("../src/statusline/snapshot.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    setSessionPinned(s, true);
    saveSession(s);
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const snaps = await collectSnapshots({
      sessionId: s.meta.id,
      fetchPlan: false,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
    });
    assert.equal(snaps.length, 1);
    assert.ok(snaps[0]!.tags.includes("PIN"), String(snaps[0]!.tags));
    assert.equal(snaps[0]!.pinned, true);
  });
});

describe("statusline lastError snapshot", () => {
  it("sessionToSnapshot includes lastError and ERR tag", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-lasterr-"));
    process.env.FORGE_HOME = tmp;
    const { sessionToSnapshot } = await import("../src/statusline/snapshot.js");
    const { setSessionLastError, saveSession } = await import(
      "../src/session/session.js"
    );
    const { renderTmux, renderCompactStrip, renderHud } = await import(
      "../src/statusline/render.js"
    );
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "rate_limited",
      message: "xai HTTP 429",
      tips: ["forge accounts switch"],
    });
    saveSession(s);
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.lastError);
    assert.equal(snap.lastError!.code, "rate_limited");
    assert.match(snap.lastError!.message, /429/);
    assert.ok(snap.tags.some((t) => t.startsWith("ERR:")));
    assert.match(renderTmux(snap), /ERR:rate_limited/);
    assert.match(renderCompactStrip(snap, { plain: true }), /ERR:rate_limited/);
    assert.match(renderHud([snap], { plain: true, width: 120 }), /ERR:rate_limited/);
  });

  it("clears transient quota ERR so resume does not keep the banner", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-quota-"));
    process.env.FORGE_HOME = tmp;
    const {
      setSessionLastError,
      clearTransientProviderError,
      saveSession,
    } = await import("../src/session/session.js");
    const { sessionToSnapshot } = await import("../src/statusline/snapshot.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "quota_exhausted",
      message: "quota",
    });
    saveSession(s);
    assert.ok(
      sessionToSnapshot(s, { authMethod: "api_key" }).tags.some((t) =>
        t.startsWith("ERR:"),
      ),
    );
    assert.equal(clearTransientProviderError(s), true);
    saveSession(s);
    assert.ok(
      !sessionToSnapshot(s, { authMethod: "api_key" }).tags.some((t) =>
        t.startsWith("ERR:"),
      ),
    );
    setSessionLastError(s, { code: "max_turns", message: "cap" });
    assert.equal(clearTransientProviderError(s), false);
    assert.equal(s.meta.lastError?.code, "max_turns");
  });

  it("does not paint HUD ERR for a successful ULW wrap", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-cycle-ok-"));
    process.env.FORGE_HOME = tmp;
    const { setSessionLastError, saveSession } = await import(
      "../src/session/session.js"
    );
    const { sessionToSnapshot } = await import("../src/statusline/snapshot.js");
    const { renderHud } = await import("../src/statusline/render.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "ulw_cycle_complete",
      message: "ULW last cycle attested complete — released.",
    });
    saveSession(s);
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.equal(snap.lastError?.code, "ulw_cycle_complete");
    assert.ok(!snap.tags.some((t) => t.startsWith("ERR:")));
    assert.doesNotMatch(
      renderHud([snap], { plain: true, width: 120 }),
      /ERR:ulw_cycle_complete/,
    );
  });

  it("tags YOLO for permissionMode aliases (yolo/always/bypass)", async () => {
    const { sessionToSnapshot } = await import("../src/statusline/snapshot.js");
    const { buildPromptFlags } = await import("../src/tui/status-bar.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-yolo-"));
    process.env.FORGE_HOME = tmp;
    process.env.FORGE_BOTTOM_STATUS = "0";
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    for (const alias of ["yolo", "always", "bypass"] as const) {
      const snap = sessionToSnapshot(s, {
        permissionMode: alias as any,
        workspace: tmp,
      } as any);
      assert.ok(
        snap.tags.includes("YOLO"),
        `sessionToSnapshot must YOLO-tag permissionMode=${alias}`,
      );
      const flags = buildPromptFlags({
        config: {
          ...DEFAULT_CONFIG,
          permissionMode: alias as any,
          workspace: tmp,
        },
        session: s,
        auth: { provider: "xai", method: "api_key", apiKey: "t" } as any,
      });
      const plain = flags.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(
        plain,
        /YOLO/,
        `buildPromptFlags must show YOLO for permissionMode=${alias}`,
      );
    }
  });

  it("docked forge › drops ULW/GOAL/PLAN/YOLO the dock already paints", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-dock-flags-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.pinned = true;
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = new Date().toISOString();
    armUlwCycle(s.meta.id, "improve", { cycle: 1, maxWaves: 2 });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "bypassPermissions" as const,
    };
    const auth = { provider: "xai", method: "api_key", apiKey: "t" } as any;
    const docked = buildPromptFlags(
      { config, session: s, auth, verbose: true },
      { identity: "docked" },
    ).replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(docked, /ULW/);
    assert.doesNotMatch(docked, /YOLO/);
    assert.doesNotMatch(docked, /PLAN/);
    assert.match(docked, /PIN/);
    assert.match(docked, /✓/);
    assert.match(docked, /VERBOSE/);
    const standalone = buildPromptFlags(
      { config, session: s, auth },
      { identity: "standalone" },
    ).replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(standalone, /ULW/);
    assert.match(standalone, /YOLO/);
    const auto = buildPromptFlags(
      {
        config: { ...config, permissionMode: "acceptEdits" },
        session: s,
        auth,
      },
      { identity: "docked" },
    ).replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(auto, /auto/);
  });
});

describe("statusline plan mode details", () => {
  it("formatSessionDetails tips /build under plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-plan-"));
    process.env.FORGE_HOME = tmp;
    // Prefer the project git root — sandboxed `git init` often fails (chmod on
    // .git/config.lock). Fall back to tmp without git assertions if needed.
    const { findGitRoot } = await import("../src/agent/worktree.js");
    const projectRoot =
      findGitRoot(process.cwd()) || findGitRoot(path.resolve(".")) || tmp;
    const { formatSessionDetails } = await import("../src/tui/status-bar.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: projectRoot, provider: "xai", model: "m" });
    const auth = {
      provider: "xai",
      method: "api_key",
      token: "t",
    } as ResolvedAuth;
    const text = formatSessionDetails({
      config: {
        ...DEFAULT_CONFIG,
        permissionMode: "plan",
        workspace: projectRoot,
      },
      session: s,
      auth,
    });
    assert.match(text, /plan/i);
    assert.match(text, /\/build/);
    assert.match(text, /ctx\s+|autoCompact@/);
    if (projectRoot !== tmp) {
      assert.match(text, /git\s+/);
    }
  });

  it("formatSessionDetails surfaces lastError recovery tip", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-err-"));
    process.env.FORGE_HOME = tmp;
    const { formatSessionDetails } = await import("../src/tui/status-bar.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { setSessionLastError } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "rate_limited",
      message: "xai HTTP 429: rate limit",
      tips: ["forge accounts switch"],
    });
    const auth = {
      provider: "xai",
      method: "api_key",
      token: "t",
    } as ResolvedAuth;
    const text = formatSessionDetails({
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session: s,
      auth,
    });
    assert.match(text, /lastErr/);
    assert.match(text, /rate_limited/);
    assert.match(text, /accounts switch/);
  });
});

describe("HUD contract — one identity strip", () => {
  it("dock-off live header is identity + harness, not a boxed catalog", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live-hdr-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const text = renderLiveRunHeader({
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session: s,
      auth: {
        provider: "xai",
        method: "api_key",
        token: "t",
      } as ResolvedAuth,
    });
    assert.doesNotMatch(text, /live run/);
    assert.match(text, /xai\/grok-4/);
    assert.doesNotMatch(text, /\/cycle 0/);
    assert.doesNotMatch(text, /\/budget/);
    assert.doesNotMatch(text, /type at/);
    assert.doesNotMatch(text, /┌/);
    assert.doesNotMatch(text, /\/notify/);
    assert.doesNotMatch(text, /\/status/);
    const clipped = renderLiveRunHeader(
      {
        config: { ...DEFAULT_CONFIG, workspace: tmp },
        session: s,
        auth: {
          provider: "xai",
          method: "api_key",
          token: "t",
        } as ResolvedAuth,
      },
      20,
    );
    const { visibleWidth } = await import("../src/util/format.js");
    assert.ok(visibleWidth(clipped) <= 24);
  });

  it("dock-off live header shows PLAN when permissionMode is plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live-plan-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const text = renderLiveRunHeader({
      config: { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "plan" },
      session: s,
      auth: {
        provider: "xai",
        method: "api_key",
        token: "t",
      } as ResolvedAuth,
    });
    assert.match(text, /PLAN/);
  });

  it("docked live › is phase + work, not a second identity/ctx/ULW strip", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hud-docked-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.meta.totalCompletionTokens = 3200;
    const ctx = {
      config: {
        ...DEFAULT_CONFIG,
        workspace: tmp,
        reasoningEffort: "high" as const,
        contextWindow: 500_000,
      },
      session: s,
      auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
    };
    const plain = buildLivePrompt(ctx, {
      identity: "docked",
      width: 120,
      frame: 0,
      phase: "waiting",
      detail: "retry 2/3",
    }).replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /wait retry 2\/3/);
    assert.match(plain, /live ›/);
    assert.doesNotMatch(plain, /waiting on bg/);
    assert.doesNotMatch(plain, /xai\/grok/);
    assert.doesNotMatch(plain, /\bctx /);
    assert.doesNotMatch(plain, /⇣/);
    assert.doesNotMatch(plain, /\bhigh\b/);
  });

  it("waiting labels stay honest — never invent 'waiting on bg'", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hud-wait-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const ctx = {
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session: s,
      auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
    };
    const busy = renderBusyStatusLine(ctx, "waiting", "retry 2/3", 0, 120).replace(
      /\x1b\[[0-9;]*m/g,
      "",
    );
    assert.match(busy, /waiting retry 2\/3/);
    assert.doesNotMatch(busy, /waiting on bg/);
    const bare = renderBusyStatusLine(ctx, "waiting", undefined, 0, 80).replace(
      /\x1b\[[0-9;]*m/g,
      "",
    );
    assert.match(bare, /waiting…/);
    assert.doesNotMatch(bare, /waiting on bg/);
  });
});

describe("statusline tmux badges", () => {
  it("includes PIN for pinned sessions", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-tmux-pin-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession, setSessionPinned } = await import(
      "../src/session/session.js"
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { collectSnapshots } = await import("../src/statusline/snapshot.js");
    const { renderTmux } = await import("../src/statusline/render.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    setSessionPinned(s, true);
    saveSession(s);
    const snaps = await collectSnapshots({
      sessionId: s.meta.id,
      fetchPlan: false,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
    });
    const line = renderTmux(snaps[0]);
    assert.match(line, /PIN/);
  });

  it("formatSessionDetails shows verify line / no-verify tip", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-details-verify-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    s.meta.editCount = 2;
    delete s.meta.lastVerificationCommand;
    const auth = { provider: "xai", method: "api_key", apiKey: "t" } as any;
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const details = formatSessionDetails({ config, session: s, auth });
    const plain = details.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /verify\s+\(none after 2 edit/);
    s.meta.lastVerificationCommand = "npm test";
    const details2 = formatSessionDetails({ config, session: s, auth });
    const plain2 = details2.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain2, /verify\s+npm test/);
  });

  it("formatSessionDetails shows ULW badge without the live-controls lecture", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-details-ulw-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    armUlwCycle(s.meta.id, "improve the daily REPL", { skipCheckpoint: true });
    const auth = { provider: "xai", method: "api_key", apiKey: "t" } as any;
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const plain = formatSessionDetails({ config, session: s, auth }).replace(
      /\x1b\[[0-9;]*m/g,
      "",
    );
    assert.match(plain, /ulw\s+/);
    assert.doesNotMatch(plain, /Live mid-run/);
    assert.doesNotMatch(plain, /type while working/);
  });

  it("formatSessionDetails surfaces served-model divergence (and stays quiet otherwise)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-details-served-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({
      cwd: tmp,
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    const auth = { provider: "deepseek", method: "api_key", apiKey: "t" } as any;
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const strip = (d: string) => d.replace(/\x1b\[[0-9;]*m/g, "");

    // No divergence recorded → no served line.
    assert.doesNotMatch(strip(formatSessionDetails({ config, session: s, auth })), /served\s+⚠/);

    // Provider routed to a different tier → loud, checkable line.
    s.meta.servedModels = ["deepseek-v4-pro"];
    const plain = strip(formatSessionDetails({ config, session: s, auth }));
    assert.match(plain, /served\s+⚠ provider served deepseek-v4-pro for requested deepseek-v4-flash/);
  });

  it("status snapshot includes lastEditAt + lastVerificationStale", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-snap-stale-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const { collectSnapshots } = await import("../src/statusline/snapshot.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    s.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    s.meta.editCount = 1;
    saveSession(s);
    const snaps = await collectSnapshots({ forgeHome: tmp, cwd: tmp });
    const mine = snaps.find((x: any) => x.sessionId === s.meta.id) || snaps[0];
    assert.ok(mine);
    assert.equal(mine!.lastEditAt, "2026-04-10T12:10:00.000Z");
    assert.equal(mine!.lastVerificationStale, true);
  });

  it("prompt flags surface WT for linked worktrees", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wt-flag-"));
    process.env.FORGE_HOME = tmp;
    // Mock getGitSnapshot via real git worktree is heavy; unit-test the flag
    // path by stubbing module is awkward — instead call buildPromptFlags after
    // monkey-patching getGitSnapshot on the imported module is not available.
    // Use a real nested worktree when git allows; otherwise skip.
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    let wtDir = "";
    try {
      const { execFileSync } = await import("node:child_process");
      const main = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wt-main-"));
      execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: main, stdio: "ignore" });
      fs.writeFileSync(path.join(main, "a.txt"), "x\n");
      execFileSync("git", ["add", "a.txt"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "i"], {
        cwd: main,
        stdio: "ignore",
      });
      wtDir = path.join(os.tmpdir(), `forge-wt-link-${Date.now()}`);
      execFileSync(
        "git",
        ["worktree", "add", "--detach", wtDir, "HEAD"],
        { cwd: main, stdio: "ignore" },
      );
    } catch {
      return; // sandbox cannot create worktrees
    }
    const s = createSession({ cwd: wtDir, provider: "xai", model: "grok-4" });
    const auth = { provider: "xai", method: "api_key", apiKey: "t" } as any;
    const flags = buildPromptFlags({
      config: { ...DEFAULT_CONFIG, workspace: wtDir },
      session: s,
      auth,
    });
    const plain = flags.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /\bWT\b/);
  });

  it("redocks live › on waiting / compact / stop_guard, not mid-tool", () => {
    assert.equal(shouldRedockLiveOnPhase("thinking"), true);
    assert.equal(shouldRedockLiveOnPhase("waiting"), true);
    assert.equal(shouldRedockLiveOnPhase("compacting"), true);
    assert.equal(shouldRedockLiveOnPhase("stop_guard"), true);
    assert.equal(shouldRedockLiveOnPhase("tool"), false);
    assert.equal(shouldRedockLiveOnPhase("waiting", 1), false);
    assert.equal(shouldRedockLiveOnPhase("thinking", 2), false);
  });

  it("clips live › to one TTY row and keeps the caret", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live-clip-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const ctx = {
      config: { ...DEFAULT_CONFIG, workspace: tmp, reasoningEffort: "high" as const },
      session: s,
      auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
    };
    const wide = buildLivePrompt(ctx, { width: 120, frame: 0, phase: "thinking" });
    assert.match(wide.replace(/\x1b\[[0-9;]*m/g, ""), /live ›/);
    assert.ok(visibleWidth(wide) <= 120);

    const narrow = buildLivePrompt(ctx, { width: 24, frame: 0, phase: "thinking" });
    const plain = narrow.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /live ›/);
    assert.ok(visibleWidth(narrow) <= 24, `width ${visibleWidth(narrow)} > 24: ${plain}`);
    assert.equal(plain.includes("\n"), false);
  });

  it("mid-run live ACK is one line, not a box + lecture", () => {
    const prevCols = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      configurable: true,
    });
    try {
      const ok = formatLiveControlFeedback("/cycle 0", "Cycle flag → 0 (LAST)", "ok");
      const plain = ok.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain, /live ✓ \/cycle 0/);
      assert.match(plain, /Cycle flag/);
      assert.equal(plain.includes("\n"), false);
      assert.doesNotMatch(plain, /still open/);
      assert.doesNotMatch(plain, /──/);
      assert.ok(visibleWidth(ok) <= 80);

      const queued = formatLiveControlFeedback("keep going", "Queued for this turn.", "info");
      assert.match(queued.replace(/\x1b\[[0-9;]*m/g, ""), /live · keep going/);

      const warn = formatLiveControlFeedback("/commit", "That command would start a new turn mid-run.", "warn");
      assert.match(warn.replace(/\x1b\[[0-9;]*m/g, ""), /live ⚠ \/commit/);

      const multi = formatLiveControlFeedback("/status", "line one\nline two\nline three", "ok");
      const multiPlain = multi.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(multiPlain, /live ✓ \/status/);
      assert.match(multiPlain, /line two/);
      assert.doesNotMatch(multiPlain, /still open/);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: prevCols,
        configurable: true,
      });
    }
  });

  it("live › shows ▶ current todo instead of todos:N", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live-todo-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.todos = [
      { id: "w2", content: "ship HUD", status: "in_progress" },
      { id: "w3", content: "review", status: "pending" },
    ];
    const ctx = {
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session: s,
      auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
    };
    const plain = buildLivePrompt(ctx, { width: 80, frame: 0, phase: "thinking" }).replace(
      /\x1b\[[0-9;]*m/g,
      "",
    );
    assert.match(plain, /▶ ship HUD \+1/);
    assert.doesNotMatch(plain, /todos:2/);
  });

  it("clips idle forge › to one TTY row and keeps the caret", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-idle-clip-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { armUlwCycle } = await import("../src/harness/ulw-cycle.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    armUlwCycle(s.meta.id, "improve", { cycle: 1, maxWaves: 4 });
    s.meta.pinned = true;
    const ctx = {
      config: {
        ...DEFAULT_CONFIG,
        workspace: tmp,
        permissionMode: "bypassPermissions" as const,
      },
      session: s,
      auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
      verbose: true,
    };
    const wide = buildIdlePrompt(ctx, { width: 120 }).replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(wide, /forge › $/);
    assert.match(wide, /ULW/);
    const clipped = buildIdlePrompt(ctx, { width: 18 });
    assert.ok(visibleWidth(clipped) <= 18);
    const plain = clipped.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /forge › $/);
    assert.doesNotMatch(plain, /\n/);
  });

  it("clips busy ⚒ line to one TTY row", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-busy-clip-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { armUlwCycle } = await import("../src/harness/ulw-cycle.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    armUlwCycle(s.meta.id, "improve", { cycle: 1, maxWaves: 4 });
    const ctx = {
      config: {
        ...DEFAULT_CONFIG,
        workspace: tmp,
        reasoningEffort: "high" as const,
      },
      session: s,
      auth: { provider: "xai", method: "api_key", token: "t" } as ResolvedAuth,
    };
    const wide = renderBusyStatusLine(ctx, "thinking", "streaming", 0, 120);
    assert.match(wide.replace(/\x1b\[[0-9;]*m/g, ""), /⚒/);
    assert.ok(visibleWidth(wide) <= 120);

    const narrow = renderBusyStatusLine(
      ctx,
      "tool",
      "write_file src/tui/status-bar.ts",
      0,
      24,
    );
    const plain = narrow.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(visibleWidth(narrow) <= 24, `width ${visibleWidth(narrow)} > 24: ${plain}`);
    assert.equal(plain.includes("\n"), false);
    assert.match(plain, /⚒/);
  });

  it("prompt-docked stream heartbeat calls onStreamTick, not the stderr reminder", async () => {
    const ticks: number[] = [];
    let streaming = false;
    const indicator = createWorkingIndicator({
      dockInPrompt: true,
      streamTickMs: 30,
      onTick: () => {
        if (streaming) throw new Error("onTick must stay quiet while streaming");
      },
      onStreamTick: (frame) => {
        ticks.push(frame);
      },
    });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      indicator.start();
      streaming = true;
      indicator.setStreaming(true);
      await new Promise((r) => setTimeout(r, 450));
    } finally {
      process.stderr.write = origWrite;
      indicator.stop();
    }
    assert.ok(ticks.length >= 1, "expected at least one stream heartbeat");
    assert.ok(
      !writes.some((w) => w.includes("still working")),
      "wired onStreamTick must not fall back to the stderr reminder",
    );
  });
});
