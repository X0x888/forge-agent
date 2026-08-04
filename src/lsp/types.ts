/**
 * LSP types + language → server defaults.
 */

export type LspAction =
  | "diagnostics"
  | "hover"
  | "definition"
  | "references"
  | "symbols"
  | "workspace_symbols"
  | "status";

export interface LspServerConfig {
  /** Language id (typescript, python, rust, go, …) */
  languageId: string;
  /** Extensions without dot */
  extensions: string[];
  command: string;
  args?: string[];
  /** Extra initialization options */
  initializationOptions?: unknown;
  /** Disable this server */
  disabled?: boolean;
}

export interface LspConfigFile {
  /** Master switch */
  enabled?: boolean;
  servers?: Record<string, Partial<LspServerConfig> & { command?: string }>;
  /** Disable auto-discovery of default servers */
  noDefaults?: boolean;
}

export interface LspDiagnostic {
  path: string;
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
  severity: "error" | "warning" | "info" | "hint" | "unknown";
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspServerStatus {
  languageId: string;
  state: "idle" | "starting" | "ready" | "error" | "missing";
  command: string;
  error?: string;
  openDocuments?: number;
}

/** Built-in language server recipes (binary must be on PATH). */
export const DEFAULT_LSP_SERVERS: LspServerConfig[] = [
  {
    languageId: "typescript",
    extensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  {
    languageId: "python",
    extensions: ["py", "pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  {
    languageId: "rust",
    extensions: ["rs"],
    command: "rust-analyzer",
    args: [],
  },
  {
    languageId: "go",
    extensions: ["go"],
    command: "gopls",
    args: [],
  },
  {
    languageId: "json",
    extensions: ["json", "jsonc"],
    command: "vscode-json-language-server",
    args: ["--stdio"],
  },
  {
    languageId: "css",
    extensions: ["css", "scss", "less"],
    command: "vscode-css-language-server",
    args: ["--stdio"],
  },
  {
    languageId: "html",
    extensions: ["html", "htm"],
    command: "vscode-html-language-server",
    args: ["--stdio"],
  },
  {
    languageId: "yaml",
    extensions: ["yaml", "yml"],
    command: "yaml-language-server",
    args: ["--stdio"],
  },
];

export function severityLabel(n: number | undefined): LspDiagnostic["severity"] {
  switch (n) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "unknown";
  }
}

export function languageIdForPath(
  filePath: string,
  servers: LspServerConfig[],
): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!ext) return null;
  for (const s of servers) {
    if (s.disabled) continue;
    if (s.extensions.map((e) => e.toLowerCase()).includes(ext)) {
      return s.languageId;
    }
  }
  return null;
}
