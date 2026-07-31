import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeAuthStore,
  loadAuthStore,
  saveAuthStore,
  upsertApiKey,
  upsertOAuth,
  getCredential,
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
  isQuotaOrRateLimitError,
  recordAccountPlan,
  formatAccountsTable,
  formatMultiAccountReadiness,
  assessMultiAccountReadiness,
  clearAccountCooldown,
  isPlanFresh,
  PLAN_STALE_SEC,
  AUTH_FAILURE_COOLDOWN_SEC,
} from "../src/auth/accounts.js";
import { resolveAuth } from "../src/auth/resolve.js";
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
    assert.match(t, /accounts status|login --add/i);
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
