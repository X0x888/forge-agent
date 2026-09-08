/**
 * Deterministic colour for the suite and for colour tests that import this
 * first. Grok sessions export `NO_COLOR=1`; some TTYs set `FORCE_COLOR`.
 * Content assertions still strip ANSI (`./ansi.ts`) so a file run without
 * this pin does not match escapes in the middle of a label.
 */
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "1";
