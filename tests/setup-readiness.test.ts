import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessSetupReadiness,
  formatSetupCard,
  formatSetupCompactLine,
  parseSetupAction,
  alreadyOnboarded,
  setupAutoCardDisabled,
} from "../src/util/setup-readiness.js";
import { formatBanner } from "../src/tui/banner.js";
import {
  pickTurnEndHint,
  shouldShowFirstPermissionHint,
  FIRST_PERMISSION_HINT,
  ABORT_RECOVERY,
} from "../src/tui/hints.js";
import {
  parseLoginOfferChoice,
  shouldOfferLoginPicker,
  formatLoginOffer,
} from "../src/tui/login-offer.js";
import { helpFor, parseHelpTopic, HELP_START, HELP_ALL } from "../src/commands/help-text.js";

const base = {
  authenticated: true,
  provider: "xai",
  model: "grok-4.6",
  seenProviderModelConfirm: false,
  effectiveMaxCostUsd: null as number | null,
  projectRulesCount: 0,
  notifyOn: false,
  bellOn: false,
  lspMissing: ["typescript", "python"],
};

describe("assessSetupReadiness", () => {
  it("counts ready items and flags blocking auth", () => {
    const r = assessSetupReadiness({ ...base, authenticated: false });
    assert.equal(r.total, 6);
    assert.equal(r.blocking, true);
    assert.equal(r.items.find((i) => i.id === "auth")?.ready, false);
    assert.equal(r.recommendedOpen, 3);
  });

  it("treats confirmed model, budget, rules as ready", () => {
    const r = assessSetupReadiness({
      ...base,
      seenProviderModelConfirm: true,
      effectiveMaxCostUsd: 5,
      projectRulesCount: 1,
      notifyOn: true,
      lspMissing: [],
    });
    assert.equal(r.ready, 6);
    assert.equal(r.blocking, false);
    assert.equal(r.recommendedOpen, 0);
  });

  it("lsp ready when disabled even if missing", () => {
    const r = assessSetupReadiness({
      ...base,
      lspDisabled: true,
      lspMissing: ["typescript"],
    });
    assert.equal(r.items.find((i) => i.id === "lsp")?.ready, true);
  });

  it("formats card and compact line", () => {
    const r = assessSetupReadiness(base);
    const card = formatSetupCard(r);
    assert.match(card, /Setup  \d\/6 ready/);
    assert.match(card, /\[ \].*spend cap/);
    assert.match(card, /\/setup skip/);
    const compact = formatSetupCompactLine(r);
    assert.match(compact, /setup \d\/6/);
    assert.match(compact, /no spend cap/);
    assert.match(compact, /no AGENTS\.md/);
    assert.match(compact, /\/setup to finish/);
    assert.doesNotMatch(compact, /notify off|lsp missing/);
  });

  it("compact line ignores optional notify/lsp residue", () => {
    const r = assessSetupReadiness({
      ...base,
      seenProviderModelConfirm: true,
      effectiveMaxCostUsd: 5,
      projectRulesCount: 1,
    });
    assert.equal(r.recommendedOpen, 0);
    assert.equal(r.blocking, false);
    const compact = formatSetupCompactLine(r);
    assert.match(compact, /setup 4\/6 ready/);
    assert.doesNotMatch(compact, /notify off|lsp missing|\/setup to finish/);
  });
});

describe("parseSetupAction", () => {
  it("maps numbers and verbs", () => {
    assert.deepEqual(parseSetupAction(""), { kind: "card" });
    assert.equal(parseSetupAction("json").kind, "json");
    assert.equal(parseSetupAction("skip").kind, "skip");
    assert.equal(parseSetupAction("1").kind, "model");
    assert.deepEqual(parseSetupAction("budget 5"), {
      kind: "budget",
      amount: "5",
    });
    assert.deepEqual(parseSetupAction("3 CI"), { kind: "init", focus: "CI" });
    assert.equal(parseSetupAction("6").kind, "scaffold");
    assert.equal(parseSetupAction("nope").kind, "help");
  });
});

describe("onboard flags", () => {
  it("seenWelcomeTip counts as already onboarded", () => {
    assert.equal(alreadyOnboarded({}), false);
    assert.equal(alreadyOnboarded({ seenWelcomeTip: true }), true);
    assert.equal(alreadyOnboarded({ seenSetup: true }), true);
  });

  it("FORGE_SETUP=0 disables auto card", () => {
    const prev = process.env.FORGE_SETUP;
    process.env.FORGE_SETUP = "0";
    assert.equal(setupAutoCardDisabled(), true);
    process.env.FORGE_SETUP = "1";
    assert.equal(setupAutoCardDisabled(), false);
    if (prev === undefined) delete process.env.FORGE_SETUP;
    else process.env.FORGE_SETUP = prev;
  });
});

describe("formatBanner", () => {
  it("is slim and says type a task on first session", () => {
    const text = formatBanner({
      version: "0.9.99",
      provider: "xai",
      model: "grok-4.6",
      authLabel: "xai via subscription",
      sessionId: "abcdefghijklmnop",
      permissionMode: "default",
      sandbox: "workspace",
      blockingStop: true,
      posture: "posture: effort xhigh",
      showEmptyState: true,
    });
    assert.match(text, /⚒  Forge v0\.9\.99/);
    assert.match(text, /session abcdefgh/);
    assert.match(text, /Type a task in English/);
    assert.match(text, /\/setup/);
    assert.doesNotMatch(text, /\/cycle 0/);
    assert.doesNotMatch(text, /Paste multi-line/);
  });

  it("renders git branch + dirty and project bits on the identity line", () => {
    const text = formatBanner({
      version: "0.9.99",
      provider: "xai",
      model: "grok-4.6",
      authLabel: "xai",
      sessionId: "abcdefghijklmnop",
      permissionMode: "default",
      sandbox: "workspace",
      blockingStop: true,
      posture: "posture: —",
      gitBranch: "main",
      gitDirty: true,
      projectBits: ["pm=npm", "node"],
    });
    assert.match(text, /main\*/);
    assert.match(text, /pm=npm/);
    assert.match(text, /node/);
    // Identity line, not a third chrome row.
    const identity = text.split("\n")[1] ?? "";
    assert.match(identity, /main\*/);
    assert.match(identity, /pm=npm/);
  });

  it("advertises live › only when ULW is on", () => {
    const text = formatBanner({
      version: "1",
      provider: "xai",
      model: "m",
      authLabel: "xai",
      sessionId: "id",
      permissionMode: "default",
      sandbox: "workspace",
      blockingStop: true,
      posture: "posture: —",
      ulwArmed: true,
    });
    assert.match(text, /\/cycle 0/);
  });

  it("shows resume orientation on a returning session, not first-run", () => {
    const returning = formatBanner({
      version: "1",
      provider: "xai",
      model: "m",
      authLabel: "xai",
      sessionId: "id",
      permissionMode: "default",
      sandbox: "workspace",
      blockingStop: true,
      posture: "posture: —",
      resumeOrientation: "you: fix the lease\nFiles: src/tui/repl.ts",
    });
    assert.match(returning, /you: fix the lease/);
    assert.match(returning, /\/last {2}· {2}\/files {2}· {2}\/retry/);
    const fresh = formatBanner({
      version: "1",
      provider: "xai",
      model: "m",
      authLabel: "xai",
      sessionId: "id",
      permissionMode: "default",
      sandbox: "workspace",
      blockingStop: true,
      posture: "posture: —",
      showEmptyState: true,
      resumeOrientation: "you: leftover from a prior session",
    });
    assert.doesNotMatch(fresh, /leftover from a prior session/);
    assert.match(fresh, /Type a task in English/);
  });
});

describe("hints", () => {
  it("prioritizes no AGENTS.md after edits", () => {
    const h = pickTurnEndHint({
      dismissed: [],
      hadFileEdits: true,
      projectRulesCount: 0,
      sessionCostUsd: 1,
      hasBudget: false,
      turnElapsedSec: 200,
      notifyOn: false,
      bellOn: false,
    });
    assert.equal(h?.id, "no_agents");
  });

  it("then budget, then long-run notify", () => {
    const budget = pickTurnEndHint({
      dismissed: ["no_agents"],
      hadFileEdits: true,
      projectRulesCount: 0,
      sessionCostUsd: 0.1,
      hasBudget: false,
      turnElapsedSec: 200,
      notifyOn: false,
      bellOn: false,
    });
    assert.equal(budget?.id, "no_budget");
    const notify = pickTurnEndHint({
      dismissed: ["no_agents", "no_budget"],
      hadFileEdits: false,
      projectRulesCount: 1,
      sessionCostUsd: 0,
      hasBudget: true,
      turnElapsedSec: 200,
      notifyOn: false,
      bellOn: false,
    });
    assert.equal(notify?.id, "long_run_notify");
  });

  it("skips when told to and respects dismissals", () => {
    assert.equal(
      pickTurnEndHint({
        dismissed: [],
        skip: true,
        hadFileEdits: true,
        projectRulesCount: 0,
        sessionCostUsd: 1,
        hasBudget: false,
        turnElapsedSec: 200,
        notifyOn: false,
        bellOn: false,
      }),
      null,
    );
    assert.equal(shouldShowFirstPermissionHint([]), true);
    assert.equal(shouldShowFirstPermissionHint(["first_permission"]), false);
    assert.match(FIRST_PERMISSION_HINT, /acceptEdits/);
    assert.match(FIRST_PERMISSION_HINT, /Enter \/ y = once/);
    assert.match(ABORT_RECOVERY, /\/retry/);
    assert.match(ABORT_RECOVERY, /Type to continue/);
    assert.match(ABORT_RECOVERY, /Ctrl\+C again to quit/);
  });
});

describe("login offer", () => {
  it("skips json/headless/non-tty", () => {
    assert.equal(shouldOfferLoginPicker({ json: true, isTty: true }), false);
    assert.equal(shouldOfferLoginPicker({ headless: true, isTty: true }), false);
    assert.equal(shouldOfferLoginPicker({ isTty: false }), false);
    assert.equal(shouldOfferLoginPicker({ isTty: true }), true);
  });

  it("parses choices", () => {
    assert.deepEqual(parseLoginOfferChoice(""), {
      kind: "oauth",
      provider: "xai",
    });
    assert.equal(parseLoginOfferChoice("2").kind, "api_key");
    assert.equal(parseLoginOfferChoice("3").kind, "provider");
    assert.equal(parseLoginOfferChoice("q").kind, "quit");
    assert.equal(parseLoginOfferChoice("4").kind, "env");
    assert.equal(parseLoginOfferChoice("anthropic").kind, "provider");
    assert.match(formatLoginOffer(), /not signed in/);
  });
});

describe("grouped help", () => {
  it("default is getting started, all is the catalog", () => {
    assert.equal(parseHelpTopic(""), "start");
    assert.equal(parseHelpTopic("all"), "all");
    const start = helpFor("");
    assert.match(start.text, /Type a coding task|Just type a coding task/);
    assert.match(start.text, /\/setup/);
    assert.doesNotMatch(start.text, /\/max-waves N\|off/);
    const all = helpFor("all");
    assert.match(all.text, /\/max-waves/);
    assert.match(all.text, /\/setup/);
    assert.match(HELP_START, /\/help all/);
    assert.match(HELP_ALL, /ask_user is a model tool|ask_user/);
    assert.match(HELP_ALL, /\/verbose/);
    assert.match(HELP_ALL, /\/skills/);
    assert.match(HELP_ALL, /Bottom dock/);
    assert.match(helpFor("settings").text, /\/verbose/);
  });

  it("topics route", () => {
    assert.match(helpFor("harness").text, /\/goal/);
    assert.match(helpFor("settings").text, /\/budget/);
    assert.match(helpFor("sessions").text, /\/resume/);
    assert.match(helpFor("safety").text, /sandbox=workspace/);
    assert.match(helpFor("nope").text, /Unknown \/help topic/);
  });
});
