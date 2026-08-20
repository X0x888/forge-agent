import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  normalizeAuthStore,
  loadAuthStore,
  saveAuthStore,
  authPath,
  upsertApiKey,
  upsertOAuth,
  getCredential,
  getAccount,
  getActiveAccount,
  listAccounts,
  listAccountSummaries,
  setActiveAccount,
  removeAccount,
  resolveAccountSelector,
  setAutoSwitchSettings,
  getAutoSwitchSettings,
  setAccountCooldown,
  setAccountPriority,
  clearAllCredentials,
  makeAccountId,
  findAccountByIdentity,
} from "../src/auth/store.js";
import {
  rankAccount,
  pickAlternateAccount,
  switchAccount,
  switchOnQuotaFailure,
  switchOnAuthFailure,
  maybeProactiveSwitch,
  isPlanRemainingExhausted,
  isPlanProactivelyExhausted,
  isHealthierSwitchTarget,
  isQuotaOrRateLimitError,
  recordAccountPlan,
  formatAccountsTable,
  formatAccountsCard,
  formatAuthCard,
  formatAccountsVerdict,
  accountsNextKeys,
  collectAccountsIssues,
  formatMultiAccountReadiness,
  assessMultiAccountReadiness,
  clearAccountCooldown,
  isPlanFresh,
  PLAN_STALE_SEC,
  AUTH_FAILURE_COOLDOWN_SEC,
} from "../src/auth/accounts.js";
import { resolveAuth } from "../src/auth/resolve.js";
import { refreshCredentialIfNeeded } from "../src/auth/refresh.js";
import { withFileLock } from "../src/util/file-lock.js";
import {
  loadPreferences,
  savePreferences,
  preferencesPath,
} from "../src/config/preferences.js";
import { loadConfig } from "../src/config/load.js";
import { ProviderApiError } from "../src/providers/errors.js";
import { nowEpoch } from "../src/util/fs.js";

describe("multi-account auth store", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ma-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    // Isolate env API keys so resolveAuth uses the store
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.FORGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("migrates v1 credentials to multi-account v2", () => {
    const v1 = {
      version: 1,
      credentials: {
        xai: {
          provider: "xai",
          method: "api_key",
          accessToken: "sk-old",
          accountLabel: "legacy",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    };
    const store = normalizeAuthStore(v1);
    assert.equal(store.version, 2);
    assert.equal(Object.keys(store.accounts).length, 1);
    const id = store.active.xai;
    assert.ok(id);
    assert.equal(store.accounts[id].accessToken, "sk-old");
    assert.equal(store.autoSwitch, true);
  });

  it("stores multiple accounts per provider and switches active", () => {
    const a = upsertApiKey("xai", "sk-a", "alice@x.com");
    const b = upsertApiKey("xai", "sk-b", "bob@x.com", { forceNew: true });
    assert.notEqual(a.accountId, b.accountId);
    assert.equal(listAccounts("xai").length, 2);

    // Latest upsert is active
    assert.equal(getActiveAccount("xai")?.accessToken, "sk-b");
    assert.equal(getCredential("xai")?.accessToken, "sk-b");

    const sw = setActiveAccount(a.accountId);
    assert.equal(sw.ok, true);
    assert.equal(getActiveAccount("xai")?.accessToken, "sk-a");
    assert.equal(getCredential("xai")?.accessToken, "sk-a");
  });

  it("updates same identity instead of duplicating", () => {
    const a = upsertOAuth("xai", {
      accessToken: "tok1",
      method: "subscription",
      accountLabel: "grok:alice@x.com",
    });
    const b = upsertOAuth("xai", {
      accessToken: "tok2",
      method: "subscription",
      accountLabel: "grok:alice@x.com",
    });
    assert.equal(a.accountId, b.accountId);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(listAccounts("xai").length, 1);
    assert.equal(getActiveAccount("xai")?.accessToken, "tok2");
  });

  it("identity lookup never matches a label-less account", () => {
    // Label-less account inserted FIRST: with the old `target.endsWith("")`
    // bug it matched every identity query and absorbed other users' tokens.
    const anon = upsertOAuth("xai", {
      accessToken: "tok-anon",
      method: "subscription",
    });
    const alice = upsertOAuth("xai", {
      accessToken: "tok-alice",
      method: "subscription",
      accountLabel: "grok:alice@x.com",
    });
    assert.equal(alice.created, true);
    assert.notEqual(alice.accountId, anon.accountId);

    // Non-empty identity queries must skip the label-less account entirely.
    assert.equal(findAccountByIdentity("xai", "grok:nobody@x.com"), undefined);
    // Exact / prefix-normalized matches still find the labeled account.
    assert.equal(
      findAccountByIdentity("xai", "grok:alice@x.com")?.id,
      alice.accountId,
    );
    assert.equal(
      findAccountByIdentity("xai", "alice@x.com")?.id,
      alice.accountId,
    );
    // Empty hint matches nothing.
    assert.equal(findAccountByIdentity("xai", ""), undefined);
    assert.equal(findAccountByIdentity("xai", undefined), undefined);
  });

  it("OAuth upsert with a new identity does not clobber a label-less account", () => {
    // refresh.ts / login.ts rotate tokens via upsertOAuth; the wrong-account
    // match used to overwrite the first label-less account's tokens.
    const anon = upsertOAuth("xai", {
      accessToken: "tok-anon-original",
      method: "subscription",
      refreshToken: "rt-anon-original",
    });
    const bob = upsertOAuth("xai", {
      accessToken: "tok-bob",
      method: "subscription",
      accountLabel: "grok:bob@x.com",
    });
    assert.equal(bob.created, true);
    assert.notEqual(bob.accountId, anon.accountId);

    const anonAfter = listAccounts("xai").find((a) => a.id === anon.accountId);
    assert.equal(anonAfter?.accessToken, "tok-anon-original");
    assert.equal(anonAfter?.refreshToken, "rt-anon-original");

    // Same identity still updates in place (no duplicate account).
    const bob2 = upsertOAuth("xai", {
      accessToken: "tok-bob-rotated",
      method: "subscription",
      accountLabel: "grok:bob@x.com",
    });
    assert.equal(bob2.accountId, bob.accountId);
    assert.equal(bob2.created, false);
    assert.equal(listAccounts("xai").length, 2);
  });

  it("resolveAccountSelector finds by label and provider:N", () => {
    upsertApiKey("xai", "sk-1", "first");
    upsertApiKey("xai", "sk-2", "second", { forceNew: true });
    const byLabel = resolveAccountSelector("first");
    assert.equal(byLabel.ok, true);
    if (byLabel.ok) assert.match(byLabel.account.accountLabel || "", /first/);

    const byIdx = resolveAccountSelector("xai:1");
    assert.equal(byIdx.ok, true);
  });

  it("removeAccount re-points active", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    assert.equal(getActiveAccount("xai")?.id, b.accountId);
    removeAccount(b.accountId);
    assert.equal(getActiveAccount("xai")?.id, a.accountId);
    assert.equal(listAccounts("xai").length, 1);
  });

  it("resolveAuth returns accountId for stored credentials", () => {
    upsertApiKey("xai", "sk-resolve", "lab");
    const cfg = loadConfig({}, tmp);
    cfg.provider = "xai";
    const auth = resolveAuth(cfg);
    assert.ok(auth);
    assert.equal(auth!.token, "sk-resolve");
    assert.ok(auth!.accountId);
  });

  it("auto-switch settings persist", () => {
    setAutoSwitchSettings({ autoSwitch: false, switchThresholdPercent: 75 });
    const s = getAutoSwitchSettings();
    assert.equal(s.autoSwitch, false);
    assert.equal(s.switchThresholdPercent, 75);
    const disk = loadAuthStore();
    assert.equal(disk.autoSwitch, false);
    assert.equal(disk.switchThresholdPercent, 75);
  });
});

describe("smart account switching", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sw-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.FORGE_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("detects quota / rate-limit errors", () => {
    assert.equal(
      isQuotaOrRateLimitError(
        new ProviderApiError({
          provider: "xai",
          status: 429,
          body: "rate limit",
        }),
      ),
      true,
    );
    assert.equal(
      isQuotaOrRateLimitError(new Error("insufficient_quota for plan")),
      true,
    );
    assert.equal(
      isQuotaOrRateLimitError(new Error("invalid_api_key")),
      false,
    );
  });

  it("ranks healthier accounts higher", () => {
    const low = {
      id: "xai:low",
      provider: "xai",
      method: "api_key" as const,
      accessToken: "a",
      createdAt: "t",
      updatedAt: "t",
      lastPlan: { percent: 20, fetchedAt: nowEpoch() },
      priority: 0,
    };
    const high = {
      ...low,
      id: "xai:high",
      lastPlan: { percent: 95, fetchedAt: nowEpoch() },
    };
    assert.ok(rankAccount(low) > rankAccount(high));
  });

  it("switchOnQuotaFailure cools down exhausted account", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    // b is active
    assert.equal(getActiveAccount("xai")?.id, b.accountId);

    const r = switchOnQuotaFailure("xai");
    assert.equal(r.switched, true);
    assert.equal(r.toId, a.accountId);
    assert.equal(getActiveAccount("xai")?.id, a.accountId);

    const cooled = listAccounts("xai").find((x) => x.id === b.accountId);
    assert.ok(cooled?.cooldownUntil && cooled.cooldownUntil > nowEpoch());
  });

  it("maybeProactiveSwitch when usage above threshold", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 90 });
    recordAccountPlan(b.accountId, { percent: 95, remaining: 1 });
    recordAccountPlan(a.accountId, { percent: 10, remaining: 100 });

    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, true);
    assert.equal(getActiveAccount("xai")?.id, a.accountId);
  });

  it("does not treat SuperGrok remaining=0 residue as empty when weekly % is low", () => {
    const healthy = upsertApiKey("xai", "sk-healthy", "chestnut");
    const full = upsertApiKey("xai", "sk-full", "sning", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 88 });
    setActiveAccount(healthy.accountId);
    // Observed SuperGrok lastPlan: credits-format % is live; remaining/limit
    // are stub zeros. Switching away from 1% onto 84% was the incident.
    recordAccountPlan(healthy.accountId, {
      percent: 1,
      used: 645,
      remaining: 0,
      limit: 0,
    });
    recordAccountPlan(full.accountId, {
      percent: 84,
      used: 0,
      remaining: 0,
      limit: 0,
    });

    assert.equal(
      isPlanRemainingExhausted(getAccount(healthy.accountId)?.lastPlan),
      false,
    );
    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, false);
    assert.equal(getActiveAccount("xai")?.id, healthy.accountId);
  });

  it("still switches on remaining=0 when that is a real budget remainder", () => {
    const spare = upsertApiKey("xai", "sk-spare", "spare");
    const empty = upsertApiKey("xai", "sk-empty", "empty", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 88 });
    recordAccountPlan(empty.accountId, { remaining: 0, limit: 1000 });
    recordAccountPlan(spare.accountId, { remaining: 400, limit: 1000 });

    assert.equal(
      isPlanRemainingExhausted(getAccount(empty.accountId)?.lastPlan),
      true,
    );
    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, true);
    assert.equal(getActiveAccount("xai")?.id, spare.accountId);
  });

  it("percent at threshold still switches even with remaining=0 residue", () => {
    const spare = upsertApiKey("xai", "sk-spare", "spare");
    const full = upsertApiKey("xai", "sk-full", "full", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 88 });
    recordAccountPlan(full.accountId, {
      percent: 95,
      remaining: 0,
      limit: 0,
    });
    recordAccountPlan(spare.accountId, { percent: 10, remaining: 0, limit: 0 });

    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, true);
    assert.equal(getActiveAccount("xai")?.id, spare.accountId);
  });

  it("stays put when every account is at/over the threshold", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 88 });
    recordAccountPlan(b.accountId, { percent: 90 });
    recordAccountPlan(a.accountId, { percent: 95 });
    assert.equal(getActiveAccount("xai")?.id, b.accountId);

    // Current 90% is the better of two exhausted slots — do not hop to 95%.
    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, false);
    assert.match(r.reason || "", /no healthier alternate/);
    assert.equal(getActiveAccount("xai")?.id, b.accountId);
    assert.equal(
      isHealthierSwitchTarget(
        getAccount(b.accountId)!,
        getAccount(a.accountId)!,
        88,
      ),
      false,
    );
  });

  it("hops once to the less-used account when both are over threshold", () => {
    const better = upsertApiKey("xai", "sk-better", "better");
    const worse = upsertApiKey("xai", "sk-worse", "worse", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 88 });
    recordAccountPlan(worse.accountId, { percent: 97 });
    recordAccountPlan(better.accountId, { percent: 90 });

    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, true);
    assert.equal(getActiveAccount("xai")?.id, better.accountId);

    // Cooldown on the previous slot must not be what prevents a bounce —
    // even after it expires, 97% is not a healthier target than 90%.
    clearAccountCooldown(worse.accountId);
    const r2 = maybeProactiveSwitch("xai");
    assert.equal(r2.switched, false);
    assert.equal(getActiveAccount("xai")?.id, better.accountId);
  });

  it("does not abandon a healthy account that is still in cooldown", () => {
    const healthy = upsertApiKey("xai", "sk-healthy", "healthy");
    const full = upsertApiKey("xai", "sk-full", "full", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 88 });
    setActiveAccount(healthy.accountId);
    recordAccountPlan(healthy.accountId, { percent: 1, remaining: 0, limit: 0 });
    recordAccountPlan(full.accountId, { percent: 84, remaining: 0, limit: 0 });
    setAccountCooldown(healthy.accountId, nowEpoch() + 900);

    assert.equal(isPlanProactivelyExhausted(getAccount(healthy.accountId)?.lastPlan, 88), false);
    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, false);
    assert.equal(getActiveAccount("xai")?.id, healthy.accountId);
  });

  it("maybeProactiveSwitch no-ops when auto-switch off", () => {
    upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: false });
    recordAccountPlan(b.accountId, { percent: 99 });
    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, false);
    assert.equal(getActiveAccount("xai")?.id, b.accountId);
  });

  it("pickAlternateAccount respects priority", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAccountPriority(a.accountId, 100);
    const alt = pickAlternateAccount("xai", b.accountId);
    assert.equal(alt?.id, a.accountId);
  });

  it("manual switchAccount works", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    const r = switchAccount("xai", { toId: a.accountId, reason: "test" });
    assert.equal(r.switched, true);
    assert.equal(getActiveAccount("xai")?.accessToken, "sk-a");
  });

  it("formatAccountsTable includes auto-switch line", () => {
    upsertApiKey("xai", "sk-a", "a");
    upsertApiKey("anthropic", "sk-ant", "ant");
    const t = formatAccountsTable();
    assert.match(t, /^accounts  ·  /m);
    assert.match(t, /Auto-switch/);
    assert.match(t, /xai/);
    assert.match(t, /anthropic/);
  });

  it("listAccountSummaries never includes tokens", () => {
    upsertApiKey("xai", "sk-secret-never-leak", "lab");
    const rows = listAccountSummaries();
    const json = JSON.stringify(rows);
    assert.equal(json.includes("sk-secret"), false);
    assert.ok(rows[0].id);
    assert.equal(rows[0].active, true);
  });

  it("makeAccountId is stable for same identity", () => {
    const a = makeAccountId("xai", "grok:alice@x.com");
    const b = makeAccountId("xai", "grok:alice@x.com");
    assert.equal(a, b);
    assert.match(a, /^xai:/);
  });

  it("clearAllCredentials empties store", () => {
    upsertApiKey("xai", "sk", "a");
    clearAllCredentials();
    assert.equal(listAccounts().length, 0);
    assert.equal(loadAuthStore().version, 2);
  });

  it("setAccountCooldown expires eligibility", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAccountCooldown(a.accountId, nowEpoch() + 3600);
    const alt = pickAlternateAccount("xai", b.accountId);
    // a is in cooldown — no alternate
    assert.equal(alt, null);
  });

  it("ignores stale plan data for proactive switch", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAutoSwitchSettings({ autoSwitch: true, switchThresholdPercent: 90 });
    // Stale high usage on active (b) must not trigger switch
    recordAccountPlan(b.accountId, { percent: 99 });
    // Backdate lastPlan.fetchedAt beyond PLAN_STALE_SEC
    const store = loadAuthStore();
    const acc = store.accounts[b.accountId];
    assert.ok(acc?.lastPlan);
    acc.lastPlan!.fetchedAt = nowEpoch() - PLAN_STALE_SEC - 60;
    saveAuthStore(store);
    assert.equal(isPlanFresh(acc.lastPlan), false);

    const r = maybeProactiveSwitch("xai");
    assert.equal(r.switched, false);
    assert.equal(getActiveAccount("xai")?.id, b.accountId);
    // Fresh high usage still switches
    recordAccountPlan(b.accountId, { percent: 99 });
    recordAccountPlan(a.accountId, { percent: 5 });
    const r2 = maybeProactiveSwitch("xai");
    assert.equal(r2.switched, true);
    assert.equal(getActiveAccount("xai")?.id, a.accountId);
  });

  it("switchOnAuthFailure uses shorter cooldown", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    const before = nowEpoch();
    const r = switchOnAuthFailure("xai");
    assert.equal(r.switched, true);
    assert.equal(r.toId, a.accountId);
    const cooled = listAccounts("xai").find((x) => x.id === b.accountId);
    assert.ok(cooled?.cooldownUntil);
    // Auth failure cooldown ≈ 5 min (not 15 min quota)
    const delta = (cooled!.cooldownUntil as number) - before;
    assert.ok(delta <= AUTH_FAILURE_COOLDOWN_SEC + 2);
    assert.ok(delta >= AUTH_FAILURE_COOLDOWN_SEC - 2);
  });

  it("clearAccountCooldown restores eligibility", () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    setAccountCooldown(a.accountId, nowEpoch() + 3600);
    assert.equal(pickAlternateAccount("xai", b.accountId), null);
    const r = clearAccountCooldown("xai");
    assert.equal(r.cleared, 1);
    assert.equal(pickAlternateAccount("xai", b.accountId)?.id, a.accountId);
  });

  it("assessMultiAccountReadiness reports multi-ready", () => {
    upsertApiKey("xai", "sk-a", "a");
    upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    const r = assessMultiAccountReadiness("xai");
    assert.equal(r.total, 2);
    assert.equal(r.eligible, 2);
    assert.equal(r.multiAccountReady, true);
    assert.equal(r.autoSwitch, true);
    const text = formatMultiAccountReadiness("xai");
    assert.match(text, /multi-account ready|eligible/i);
  });

  it("formatAccountsTable shows readiness + relative cooldown", () => {
    const a = upsertApiKey("xai", "sk-a", "alice");
    upsertApiKey("xai", "sk-b", "bob", { forceNew: true });
    setAccountCooldown(a.accountId, nowEpoch() + 900);
    const t = formatAccountsTable("xai");
    assert.match(t, /Auto-switch/);
    assert.match(t, /cooldown/);
    assert.match(t, /^accounts  ·  /m);
    assert.match(t, /Next  forge accounts (switch|clear-cooldown)/);
  });

  it("env API key blocks auto-switch (CI determinism)", () => {
    upsertApiKey("xai", "sk-a", "a");
    const b = upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    process.env.XAI_API_KEY = "sk-env-must-win";
    try {
      recordAccountPlan(b.accountId, { percent: 99 });
      const r = maybeProactiveSwitch("xai");
      assert.equal(r.switched, false);
      assert.match(r.reason || "", /env/i);
      const q = switchOnQuotaFailure("xai");
      assert.equal(q.switched, false);
      assert.equal(getActiveAccount("xai")?.id, b.accountId);
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });
});

describe("/accounts verdict-first card", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-acct-card-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.FORGE_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("designed empty is accounts · none, not ok", () => {
    const cli = formatAccountsCard({ surface: "cli" });
    assert.match(cli, /^accounts  ·  none/);
    assert.doesNotMatch(cli, /accounts\s+·\s+ok/);
    assert.match(cli, /Next  forge login/);
    const repl = formatAccountsCard({ surface: "repl" });
    assert.match(repl, /^accounts  ·  none/);
    assert.match(repl, /Next  \/auth/);
    assert.doesNotMatch(repl, /forge login/);
    assert.equal(formatAccountsVerdict(collectAccountsIssues([])), "accounts  ·  none");
  });

  it("REPL Next is /accounts switch <label>, not a CLI dump", () => {
    upsertApiKey("xai", "sk-a", "alice");
    upsertApiKey("xai", "sk-b", "bob", { forceNew: true });
    const repl = formatAccountsCard({ surface: "repl" });
    assert.match(repl, /^accounts  ·  ok/);
    assert.match(repl, /Next  \/accounts switch alice/);
    assert.doesNotMatch(repl, /forge accounts switch/);
    assert.deepEqual(accountsNextKeys(listAccountSummaries(), "repl"), [
      "/accounts switch alice",
    ]);
  });

  it("one healthy account is ok with no Next", () => {
    upsertApiKey("xai", "sk-a", "solo");
    const repl = formatAccountsCard({ surface: "repl" });
    assert.match(repl, /^accounts  ·  ok/);
    assert.doesNotMatch(repl, /^Next  /m);
    assert.deepEqual(accountsNextKeys(listAccountSummaries(), "repl"), []);
  });

  it("/accounts and bare /accounts switch open the card", async () => {
    upsertApiKey("xai", "sk-a", "alice");
    upsertApiKey("xai", "sk-b", "bob", { forceNew: true });
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const hooks = new HookRunner(config, tmp);
    const list = await handleSlash("/accounts", { session, config, hooks });
    assert.equal(list.handled, true);
    assert.match(String(list.output || ""), /^accounts  ·  ok/);
    assert.match(String(list.output || ""), /Next  \/accounts switch alice/);
    const bare = await handleSlash("/accounts switch", { session, config, hooks });
    assert.match(String(bare.output || ""), /Next  \/accounts switch alice/);
    assert.doesNotMatch(String(bare.output || ""), /Usage: \/accounts switch/);
  });

  it("/auth is verdict-first and does not closer /auth again", async () => {
    const empty = formatAuthCard();
    assert.match(empty, /^auth  ·  none/);
    assert.doesNotMatch(empty, /^Next  /m);
    assert.doesNotMatch(empty, /forge login/);
    upsertApiKey("xai", "sk-a", "alice");
    upsertApiKey("xai", "sk-b", "bob", { forceNew: true });
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/auth", { session, config, hooks });
    assert.equal(r.handled, true);
    const out = String(r.output || "");
    assert.match(out, /^auth  ·  ok/);
    assert.match(out, /Next  \/accounts switch alice/);
    assert.doesNotMatch(out, /Next  \/auth/);
    assert.doesNotMatch(out, /forge login/);
  });
});

describe("/accounts switch slash provider alignment", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ma-slash-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.FORGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("cross-provider switch realigns config/session/sticky provider (no token-only hot-swap)", async () => {
    upsertApiKey("xai", "sk-x", "x");
    const d = upsertApiKey("deepseek", "sk-d", "d");
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { loadPreferences } = await import("../src/config/preferences.js");
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      provider: "xai" as const,
      model: "grok-4.5",
    };
    const hooks = new HookRunner(cfg, tmp);
    const r = await handleSlash(`/accounts switch ${d.accountId}`, {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r.handled, true);
    // Full provider rebuild signal — a token-only swap would keep the xai
    // baseUrl and 401 every call with the deepseek bearer.
    assert.equal(r.providerUpdated, true);
    assert.equal(cfg.provider, "deepseek");
    assert.equal(session.meta.provider, "deepseek");
    // Catalog model for the new provider (no stale cross-provider model id).
    assert.equal(cfg.model, "deepseek-v4-flash");
    assert.equal(session.meta.model, "deepseek-v4-flash");
    // Sticky preference mirrors `forge accounts switch`.
    assert.equal(loadPreferences().provider, "deepseek");
    assert.match(r.output || "", /Active deepseek/);
  });

  it("same-provider switch stays token-only (no provider realign)", async () => {
    const a = upsertApiKey("xai", "sk-a", "a");
    upsertApiKey("xai", "sk-b", "b", { forceNew: true });
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      provider: "xai" as const,
      model: "grok-4.5",
    };
    const hooks = new HookRunner(cfg, tmp);
    const auth = {
      provider: "xai",
      method: "api_key" as const,
      token: "sk-b",
    };
    const r = await handleSlash(`/accounts switch ${a.accountId}`, {
      session,
      config: cfg,
      hooks,
      auth,
    });
    assert.equal(r.handled, true);
    assert.equal(r.authUpdated, true);
    assert.equal(r.providerUpdated, undefined);
    assert.equal(cfg.provider, "xai");
    assert.equal(cfg.model, "grok-4.5");
    assert.equal(auth.token, "sk-a");
  });
});

describe("cross-process auth store lock", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lock-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("withFileLock runs fn and removes the lockfile", () => {
    const target = path.join(tmp, "auth.json");
    assert.equal(withFileLock(target, () => 42), 42);
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });

  it("withFileLock releases the lock when fn throws", () => {
    const target = path.join(tmp, "auth.json");
    assert.throws(
      () =>
        withFileLock(target, () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });

  it("steals an age-stale lock (holder died mid-write) instead of bricking", () => {
    const lock = `${authPath()}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    upsertApiKey("xai", "sk-stale-lock", "stale");
    assert.equal(getCredential("xai")?.accessToken, "sk-stale-lock");
    assert.equal(fs.existsSync(lock), false);
  });

  it("steals a fresh lock whose pid is dead without waiting", () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(pid && pid > 0);
    const lock = `${authPath()}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid }));
    const t0 = Date.now();
    upsertApiKey("xai", "sk-dead-pid", "dead");
    assert.ok(
      Date.now() - t0 < 1_500,
      "dead-pid lock must be stolen, not waited out",
    );
    assert.equal(getCredential("xai")?.accessToken, "sk-dead-pid");
  });

  it("fails open within the wait budget on a live foreign lock", () => {
    const target = path.join(tmp, "auth.json");
    const lock = `${target}.lock`;
    // pid 1 (launchd/init) is alive and foreign — never stealable.
    fs.writeFileSync(lock, JSON.stringify({ pid: 1 }));
    const t0 = Date.now();
    const ran = withFileLock(target, () => "ran", { waitMs: 150 });
    const elapsed = Date.now() - t0;
    assert.equal(ran, "ran");
    assert.ok(elapsed < 1_500, `fail-open exceeded budget (${elapsed}ms)`);
    // A lock we never owned must survive our completion.
    assert.equal(fs.existsSync(lock), true);
  });

  it("mutators merge sequentially (rotation + cooldown both persist)", () => {
    const a = upsertOAuth("xai", {
      accessToken: "tok-r1",
      refreshToken: "rt-r1",
      method: "subscription",
    });
    setAccountCooldown(a.accountId, nowEpoch() + 600);
    const b = upsertOAuth("xai", {
      accessToken: "tok-r2",
      refreshToken: "rt-r2",
      method: "subscription",
    });
    assert.equal(b.accountId, a.accountId);
    const acc = getAccount(a.accountId);
    assert.equal(acc?.accessToken, "tok-r2");
    assert.ok(acc?.cooldownUntil && acc.cooldownUntil > nowEpoch());
  });

  it("serializes concurrent writers across processes (no lost updates)", async () => {
    // Deterministic with the lock: every child's upsert lands. Without it
    // the load→mutate→save race silently drops accounts (the rotated-token
    // loss this regression test guards).
    const storeUrl = pathToFileURL(path.resolve("src/auth/store.ts")).href;
    const CHILDREN = 3;
    const PER_CHILD = 15;
    const script = [
      `const { upsertApiKey } = await import(${JSON.stringify(storeUrl)});`,
      "const tag = process.env.FORGE_TAG;",
      "const n = Number(process.env.FORGE_N);",
      "for (let i = 0; i < n; i++) {",
      '  upsertApiKey("xai", "key-" + tag + "-" + i, "kid-" + tag + "-" + i, { forceNew: true });',
      "}",
    ].join("\n");
    await Promise.all(
      Array.from(
        { length: CHILDREN },
        (_, c) =>
          new Promise<void>((resolve, reject) => {
            const kid = spawn(
              process.execPath,
              ["--import", "tsx", "--input-type=module", "-e", script],
              {
                env: {
                  ...process.env,
                  FORGE_HOME: tmp,
                  FORGE_TAG: String(c),
                  FORGE_N: String(PER_CHILD),
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let err = "";
            kid.stderr.on("data", (d) => {
              err += d;
            });
            kid.on("exit", (code) =>
              code === 0
                ? resolve()
                : reject(
                    new Error(
                      `child ${c} exited ${code}: ${err.slice(0, 400)}`,
                    ),
                  ),
            );
          }),
      ),
    );
    assert.equal(listAccounts("xai").length, CHILDREN * PER_CHILD);
  });

  it("savePreferences survives a stale preferences lock", () => {
    const lock = `${preferencesPath()}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    savePreferences({ model: "lock-survivor" });
    assert.equal(loadPreferences().model, "lock-survivor");
  });
});

describe("oauth refresh account targeting", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-refresh-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function seedTwoLabelless() {
    const a = upsertOAuth("xai", {
      accessToken: "tok-a",
      refreshToken: "rt-a",
      method: "subscription",
      expiresAt: nowEpoch() - 100,
    });
    const b = upsertOAuth("xai", {
      accessToken: "tok-b",
      refreshToken: "rt-b",
      method: "subscription",
      expiresAt: nowEpoch() - 100,
      forceNew: true,
    });
    assert.equal(listAccounts("xai").length, 2);
    assert.equal(getActiveAccount("xai")?.id, b.accountId);
    return { a, b };
  }

  it("updates the account that was refreshed — never a per-refresh duplicate", async () => {
    const { a, b } = seedTwoLabelless();
    let sentRefreshToken = "";
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      sentRefreshToken = String(
        new URLSearchParams(init?.body as URLSearchParams).get("refresh_token"),
      );
      return new Response(
        JSON.stringify({
          access_token: "tok-b-rotated",
          refresh_token: "rt-b-rotated",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const r = await refreshCredentialIfNeeded("xai", { force: true });
    assert.equal(r.ok, true);
    assert.equal(r.refreshed, true);
    assert.equal(sentRefreshToken, "rt-b");

    // The regression: with 2+ same-method label-less accounts, upsert's
    // sameMethod.length===1 targeting missed and refresh spawned a NEW
    // account every time.
    assert.equal(listAccounts("xai").length, 2);
    const accB = getAccount(b.accountId);
    assert.equal(accB?.accessToken, "tok-b-rotated");
    assert.equal(accB?.refreshToken, "rt-b-rotated");
    // The other account is untouched.
    const accA = getAccount(a.accountId);
    assert.equal(accA?.accessToken, "tok-a");
    assert.equal(accA?.refreshToken, "rt-a");
  });

  it("invalid_grant clears the refresh token on the refreshed account only", async () => {
    const { a, b } = seedTwoLabelless();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const r = await refreshCredentialIfNeeded("xai", { force: true });
    assert.equal(r.ok, false);
    assert.equal(listAccounts("xai").length, 2);
    assert.equal(getAccount(b.accountId)?.refreshToken, undefined);
    assert.equal(getAccount(a.accountId)?.refreshToken, "rt-a");
  });
});
