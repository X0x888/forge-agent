/** Strip SGR so content assertions do not depend on chalk / FORCE_COLOR. */
export function stripAnsi(s: string): string {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}
