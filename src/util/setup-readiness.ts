/**
 * First-day setup checklist — shared by the REPL banner, /setup,
 * `forge setup`, and doctor. Not a substitute for doctor issues[]:
 * missing budget / AGENTS.md stay tips, never CI-failing.
 */

export type SetupItemId =
  | "auth"
  | "provider_model"
  | "budget"
  | "project_rules"
  | "attention"
  | "lsp";

export type SetupSeverity = "blocking" | "recommended" | "optional";

export interface SetupItem {
  id: SetupItemId;
  ready: boolean;
  label: string;
  detail: string;
  action: string;
  severity: SetupSeverity;
}

export interface SetupAssessment {
  items: SetupItem[];
  ready: number;
  total: number;
  blocking: boolean;
  recommendedOpen: number;
}

export interface SetupReadinessInput {
  authenticated: boolean;
  provider: string;
  model: string;
  seenProviderModelConfirm?: boolean;
  /** null = unlimited */
  effectiveMaxCostUsd: number | null;
  projectRulesCount: number;
  notifyOn: boolean;
  bellOn: boolean;
  lspMissing: string[];
  lspDisabled?: boolean;
}

const ITEM_ORDER: SetupItemId[] = [
  "auth",
  "provider_model",
  "budget",
  "project_rules",
  "attention",
  "lsp",
];

export function assessSetupReadiness(
  input: SetupReadinessInput,
): SetupAssessment {
  const provider = String(input.provider || "xai").trim() || "xai";
  const model = String(input.model || "").trim() || "(default)";
  const items: SetupItem[] = [
    {
      id: "auth",
      ready: Boolean(input.authenticated),
      label: "signed in",
      detail: input.authenticated ? `${provider}` : "not authenticated",
      action: "forge login",
      severity: "blocking",
    },
    {
      id: "provider_model",
      ready: Boolean(input.seenProviderModelConfirm),
      label: "provider / model",
      detail: `${provider}/${model}${
        input.seenProviderModelConfirm ? "" : "  (not confirmed)"
      }`,
      action: "/setup model",
      severity: "recommended",
    },
    {
      id: "budget",
      ready: input.effectiveMaxCostUsd != null,
      label: "spend cap",
      detail:
        input.effectiveMaxCostUsd != null
          ? `$${input.effectiveMaxCostUsd}`
          : "unlimited",
      action: "/budget 5",
      severity: "recommended",
    },
    {
      id: "project_rules",
      ready: (input.projectRulesCount || 0) > 0,
      label: "project rules",
      detail:
        (input.projectRulesCount || 0) > 0
          ? `${input.projectRulesCount} source(s)`
          : "no AGENTS.md",
      action: "/init",
      severity: "recommended",
    },
    {
      id: "attention",
      ready: Boolean(input.notifyOn || input.bellOn),
      label: "turn-end notify",
      detail: input.notifyOn
        ? "notify on"
        : input.bellOn
          ? "bell on"
          : "off",
      action: "/notify on",
      severity: "optional",
    },
    {
      id: "lsp",
      ready: Boolean(input.lspDisabled) || (input.lspMissing || []).length === 0,
      label: "language servers",
      detail: input.lspDisabled
        ? "disabled"
        : (input.lspMissing || []).length
          ? input.lspMissing.join(", ") + " missing"
          : "ready",
      action: "/lsp ensure",
      severity: "optional",
    },
  ];

  const ready = items.filter((i) => i.ready).length;
  return {
    items,
    ready,
    total: items.length,
    blocking: items.some((i) => i.severity === "blocking" && !i.ready),
    recommendedOpen: items.filter(
      (i) => i.severity === "recommended" && !i.ready,
    ).length,
  };
}

/** Full /setup card (no chalk — callers color if they want). */
export function formatSetupCard(r: SetupAssessment): string {
  const lines = [`Setup  ${r.ready}/${r.total} ready`];
  for (const item of r.items) {
    const mark = item.ready ? "x" : " ";
    const arrow = item.ready ? "" : `  →  ${item.action}`;
    lines.push(
      `  [${mark}] ${item.label.padEnd(18)} ${item.detail}${arrow}`,
    );
  }
  lines.push("");
  lines.push(
    "  1) Confirm provider / model     2) Set spend cap",
  );
  lines.push(
    "  3) Write AGENTS.md (/init)      4) Turn-end notify",
  );
  lines.push(
    "  5) Install LSP                  6) Scaffold files (forge init)",
  );
  lines.push("  Type 1–6 here  ·  /setup skip hides this  ·  /setup help");
  return lines.join("\n");
}

/** One-line banner residue while recommended items remain open. */
export function formatSetupCompactLine(r: SetupAssessment): string {
  // Optional notify/lsp belong on the full /setup card, not every resume.
  const open = r.items.filter((i) => !i.ready && i.severity !== "optional");
  if (open.length === 0) return `setup ${r.ready}/${r.total} ready`;
  const bits = open.slice(0, 3).map((i) => {
    if (i.id === "budget") return "no spend cap";
    if (i.id === "project_rules") return "no AGENTS.md";
    if (i.id === "auth") return "not signed in";
    if (i.id === "provider_model") return "model unconfirmed";
    return i.label;
  });
  const more = open.length > 3 ? ` +${open.length - 3}` : "";
  return `setup ${r.ready}/${r.total}  ·  ${bits.join("  ·  ")}${more}  ·  type 1–6 or /setup`;
}

export type SetupAction =
  | { kind: "card" }
  | { kind: "json" }
  | { kind: "skip" }
  | { kind: "help" }
  | { kind: "model" }
  | { kind: "budget"; amount?: string }
  | { kind: "init"; focus?: string }
  | { kind: "notify" }
  | { kind: "lsp" }
  | { kind: "scaffold" };

const VERB_ALIASES: Record<string, SetupAction["kind"]> = {
  status: "card",
  show: "card",
  card: "card",
  json: "json",
  skip: "skip",
  hide: "skip",
  help: "help",
  "?": "help",
  "1": "model",
  model: "model",
  confirm: "model",
  provider: "model",
  "2": "budget",
  budget: "budget",
  cap: "budget",
  "3": "init",
  init: "init",
  agents: "init",
  "4": "notify",
  notify: "notify",
  bell: "notify",
  attention: "notify",
  "5": "lsp",
  lsp: "lsp",
  "6": "scaffold",
  scaffold: "scaffold",
  files: "scaffold",
  initfiles: "scaffold",
};

/**
 * First-run numbered menu: idle `1`–`6` is the card item, not a model prompt.
 * Live/busy turns and already-onboarded sessions leave the digit alone.
 */
export function rewriteIdleSetupShortcut(
  line: string,
  opts: { enabled: boolean },
): string {
  if (!opts.enabled) return line;
  const t = String(line ?? "").trim();
  if (/^[1-6]$/.test(t)) return `/setup ${t}`;
  return line;
}

export function parseSetupAction(arg: string): SetupAction {
  const raw = String(arg || "").trim();
  if (!raw) return { kind: "card" };
  const tokens = raw.split(/\s+/);
  const head = tokens[0].toLowerCase();
  const kind = VERB_ALIASES[head];
  if (!kind) return { kind: "help" };
  if (kind === "budget") {
    return { kind: "budget", amount: tokens.slice(1).join(" ") || undefined };
  }
  if (kind === "init") {
    return { kind: "init", focus: tokens.slice(1).join(" ") || undefined };
  }
  return { kind } as SetupAction;
}

export function setupAutoCardDisabled(): boolean {
  const v = (process.env.FORGE_SETUP || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export function alreadyOnboarded(prefs: {
  seenSetup?: boolean;
  seenWelcomeTip?: boolean;
}): boolean {
  return Boolean(prefs.seenSetup || prefs.seenWelcomeTip);
}

/** Stable id order for tests / JSON. */
export function setupItemIds(): SetupItemId[] {
  return [...ITEM_ORDER];
}
