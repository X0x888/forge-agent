/**
 * Runs the whole prose corpus through the three regex classifiers the
 * harness gates on, and reports every disagreement at once — so a tweak
 * that fixes one case and breaks four is red with all five named.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeAdvisoryUserMessage } from "../src/util/advisory-intent.js";
import { detectHomework, looksLikeRunReport } from "../src/harness/report-guard.js";
import { CLOSERS, REPORTS, USER_MESSAGES } from "./fixtures/prose-corpus.js";

function disagreements<T>(
  cases: T[],
  expected: (c: T) => boolean,
  actual: (c: T) => boolean,
  label: (c: T) => string,
): string[] {
  const out: string[] = [];
  for (const c of cases) {
    const want = expected(c);
    const got = actual(c);
    if (want !== got) out.push(`  want ${want} got ${got}: ${label(c)}`);
  }
  return out;
}

describe("prose-classifier corpus", () => {
  it("looksLikeAdvisoryUserMessage agrees with every labelled user message", () => {
    const bad = disagreements(
      USER_MESSAGES,
      (c) => c.advisory,
      (c) => looksLikeAdvisoryUserMessage(c.text),
      (c) => `${JSON.stringify(c.text)} (${c.why})`,
    );
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
    assert.ok(USER_MESSAGES.length >= 30, "corpus is wide enough to mean something");
  });

  it("detectHomework agrees with every labelled closer", () => {
    const bad = disagreements(
      CLOSERS,
      (c) => c.homework,
      (c) => detectHomework(c.text).homework,
      (c) => `${JSON.stringify(c.text.slice(0, 100))} (${c.why})`,
    );
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
    assert.ok(CLOSERS.length >= 20);
  });

  it("looksLikeRunReport agrees with every labelled report", () => {
    const bad = disagreements(
      REPORTS,
      (c) => c.report,
      (c) => looksLikeRunReport(c.text),
      (c) => `${JSON.stringify(c.text.slice(0, 80))} (${c.why})`,
    );
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
  });
});
