/**
 * Merge parent + subcommand opts for `forge run`.
 * Commander defaults on the subcommand must not clobber parent CLI flags
 * (e.g. run's `--permission-mode` default `acceptEdits` vs parent `--permission-mode yolo`;
 * run's empty `--deny` default `[]` vs parent `--deny 'Bash(rm *)'`).
 */

export type MergeRunCommand = {
  optsWithGlobals?: () => Record<string, unknown>;
  getOptionValueSource?: (name: string) => string | undefined;
  parent?: { getOptionValueSource?: (name: string) => string | undefined };
};

export function mergeRunOpts(
  command: MergeRunCommand | undefined,
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...globals, ...opts };
  // Scalar keys that may exist on both parent and run with a default on run.
  for (const key of [
    "permissionMode",
    "sandbox",
    "sandboxNetwork",
    "sandboxMissing",
    "model",
    "provider",
    "baseUrl",
    "effort",
    "reasoningEffort",
    "session",
    "title",
    "cwd",
    "json",
    "continue",
    "new",
    "ulw",
    "goal",
  ] as const) {
    const localSrc = command?.getOptionValueSource?.(key);
    const parentSrc = command?.parent?.getOptionValueSource?.(key);
    // Prefer explicit CLI on either side over defaults.
    if (parentSrc === "cli" && localSrc !== "cli") {
      if (key in globals) merged[key] = globals[key];
    } else if (localSrc === "cli") {
      if (key in opts) merged[key] = opts[key];
    }
  }
  // Accumulate arrays: union parent CLI + local CLI; never let empty default wipe parent.
  for (const key of ["deny", "allow", "ask"] as const) {
    const localSrc = command?.getOptionValueSource?.(key);
    const parentSrc = command?.parent?.getOptionValueSource?.(key);
    const localArr =
      localSrc === "cli" && Array.isArray(opts[key])
        ? (opts[key] as string[])
        : [];
    const parentArr =
      parentSrc === "cli" && Array.isArray(globals[key])
        ? (globals[key] as string[])
        : [];
    if (localArr.length || parentArr.length) {
      // Dedupe while preserving order (parent first, then local).
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of [...parentArr, ...localArr]) {
        if (!seen.has(r)) {
          seen.add(r);
          out.push(r);
        }
      }
      merged[key] = out;
    } else {
      merged[key] = [];
    }
  }
  return merged;
}
