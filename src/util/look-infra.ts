/**
 * Classify native-look failures (TCC, simctl LS 115, EPERM) so a mill
 * writes `limited` once instead of burning 25 osascript turns.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { playwrightLookApplies } from "./product-kind.js";

export type LookLimitKind = "tcc" | "ls115" | "eperm" | "display" | null;

export function classifyLookLimit(text: string): LookLimitKind {
  const t = text || "";
  if (/-10004|privilege violation|not authorized to send apple events|accessibility/i.test(t)) {
    return "tcc";
  }
  if (/LSApplicationWorkspaceErrorDomain|code=115|LS 115/i.test(t)) return "ls115";
  if (/\bEPERM\b|Operation not permitted/i.test(t)) return "eperm";
  if (/display asleep|loginwindow shield|could not create image from window/i.test(t)) {
    return "display";
  }
  return null;
}

export function lookLimitReceipt(kind: LookLimitKind, detail?: string): string {
  if (kind === "tcc") {
    return (
      "Looked: limited — Accessibility/Screen Recording not granted (TCC -10004). " +
      "Do not retry osascript/System Events. Use the product CLI/`--self-test`/kernel. " +
      "Operator: grant Terminal/Forge Accessibility + Screen Recording, then /doctor." +
      (detail ? ` (${detail})` : "")
    );
  }
  if (kind === "ls115") {
    return (
      "Looked: limited — simctl openurl LS 115 (simulator did not open the scheme). " +
      "Kernel/CLI is the look; do not refill keep-promise."
    );
  }
  if (kind === "eperm") {
    return (
      "Looked: limited — EPERM on the simulator/watch face store. " +
      "Do not retry simctl privacy; treat as lease-limited."
    );
  }
  if (kind === "display") {
    return (
      "Looked: limited — no interactive display (asleep / loginwindow / 0×0 capture). " +
      "Use --write-movie / headless / CLI."
    );
  }
  return "";
}

/** Darwin Accessibility probe — fail-open (unknown is not a doctor issue). */
export function darwinAccessibilityDenied(): boolean | null {
  if (process.env.NODE_TEST_CONTEXT) return null;
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name'],
      { timeout: 800, stdio: ["ignore", "pipe", "pipe"] },
    );
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: Buffer | string }).stderr ?? "")
        : "";
    if (classifyLookLimit(`${msg}\n${stderr}`) === "tcc") return true;
    return null;
  }
}

export function nativeLookRecipe(workspace: string): string[] {
  const lines: string[] = [];
  if (!workspace) return lines;
  if (playwrightLookApplies(workspace)) return lines;
  if (fs.existsSync(path.join(workspace, "project.godot"))) {
    lines.push(
      "Native look: look_native action=movie (Godot --write-movie) or the Godot look line. Do not call_mcp playwright.",
    );
    return lines;
  }
  const names = (() => {
    try {
      return fs.readdirSync(workspace);
    } catch {
      return [] as string[];
    }
  })();
  if (names.some((n) => n.endsWith(".xcodeproj") || n === "Package.swift")) {
    lines.push(
      "Native look: call look_native (screenshot | click | sim). TCC -10004 / LS 115 is limited — do not retry osascript.",
    );
    return lines;
  }
  if (names.includes("Cargo.toml")) {
    lines.push(
      "Native look: call look_native for a window grab, or the crate's --self-test. Playwright does not apply.",
    );
  }
  return lines;
}
