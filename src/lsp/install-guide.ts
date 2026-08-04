/**
 * Language server install recipes — shown by /lsp install, status (missing), doctor.
 */
import type { LspServerConfig } from "./types.js";

export interface LspInstallRecipe {
  languageId: string;
  /** Human label */
  label: string;
  command: string;
  /** Primary install one-liner(s) */
  install: string[];
  /** Optional notes */
  notes?: string[];
  /** File extensions this covers */
  extensions: string[];
}

/** Install recipes aligned with DEFAULT_LSP_SERVERS. */
export const LSP_INSTALL_RECIPES: LspInstallRecipe[] = [
  {
    languageId: "typescript",
    label: "TypeScript / JavaScript",
    command: "typescript-language-server",
    extensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
    install: [
      "npm install -g typescript-language-server typescript",
      "# or: pnpm add -g typescript-language-server typescript",
    ],
    notes: [
      "Requires `typescript` package alongside the server.",
      "Works for JS/TS/TSX in the workspace.",
    ],
  },
  {
    languageId: "python",
    label: "Python (Pyright)",
    command: "pyright-langserver",
    extensions: ["py", "pyi"],
    install: [
      "npm install -g pyright",
      "# or: pip install pyright  (binary: pyright-langserver)",
    ],
    notes: [
      "Pyright is preferred. Alternative: `pip install python-lsp-server` → command `pylsp` (override in .forge/lsp.json).",
    ],
  },
  {
    languageId: "rust",
    label: "Rust",
    command: "rust-analyzer",
    extensions: ["rs"],
    install: [
      "rustup component add rust-analyzer",
      "# or: brew install rust-analyzer",
    ],
  },
  {
    languageId: "go",
    label: "Go",
    command: "gopls",
    extensions: ["go"],
    install: ["go install golang.org/x/tools/gopls@latest"],
    notes: ["Ensure $(go env GOPATH)/bin is on PATH."],
  },
  {
    languageId: "json",
    label: "JSON",
    command: "vscode-json-language-server",
    extensions: ["json", "jsonc"],
    install: ["npm install -g vscode-langservers-extracted"],
    notes: [
      "Package also provides vscode-css/html language servers.",
    ],
  },
  {
    languageId: "css",
    label: "CSS / SCSS / Less",
    command: "vscode-css-language-server",
    extensions: ["css", "scss", "less"],
    install: ["npm install -g vscode-langservers-extracted"],
  },
  {
    languageId: "html",
    label: "HTML",
    command: "vscode-html-language-server",
    extensions: ["html", "htm"],
    install: ["npm install -g vscode-langservers-extracted"],
  },
  {
    languageId: "yaml",
    label: "YAML",
    command: "yaml-language-server",
    extensions: ["yaml", "yml"],
    install: ["npm install -g yaml-language-server"],
  },
];

export function recipeForLanguage(
  languageId: string,
): LspInstallRecipe | undefined {
  return LSP_INSTALL_RECIPES.find(
    (r) => r.languageId === languageId.toLowerCase(),
  );
}

export function recipeForCommand(command: string): LspInstallRecipe | undefined {
  const base = command.split(/[/\\]/).pop() || command;
  return LSP_INSTALL_RECIPES.find(
    (r) => r.command === base || r.command === command,
  );
}

/** Full install guide text for /lsp install and docs. */
export function formatLspInstallGuide(opts?: {
  /** Only these language ids (or empty = all). */
  only?: string[];
  /** Highlight servers that are missing from PATH. */
  missingCommands?: Set<string>;
}): string {
  const only = opts?.only?.map((s) => s.toLowerCase());
  const lines: string[] = [
    "LSP language servers — install on PATH (Forge spawns them lazily)",
    "──────────────────────────────────────────────────────────────",
    "Config: ~/.forge/lsp.json · .forge/lsp.json  ·  FORGE_LSP=0 disables",
    "Tool: lsp({ action: \"diagnostics\"|\"hover\"|…, path, line?, character? })",
    "",
  ];
  for (const r of LSP_INSTALL_RECIPES) {
    if (only?.length && !only.includes(r.languageId)) continue;
    const missing = opts?.missingCommands?.has(r.command);
    lines.push(
      `## ${r.label} (\`${r.languageId}\`)${missing ? "  ← NOT ON PATH" : ""}`,
    );
    lines.push(`Command: ${r.command}`);
    lines.push(`Extensions: ${r.extensions.map((e) => `.${e}`).join(", ")}`);
    lines.push("Install:");
    for (const cmd of r.install) lines.push(`  ${cmd}`);
    if (r.notes?.length) {
      for (const n of r.notes) lines.push(`  note: ${n}`);
    }
    lines.push("");
  }
  lines.push(
    "After install: /lsp restart · then lsp({ action: \"diagnostics\", path: \"…\" })",
  );
  lines.push(
    "Override command/args per language in .forge/lsp.json (see docs/LSP.md).",
  );
  return lines.join("\n");
}

/** Short tips for missing servers in status output. */
export function formatMissingServerTips(
  servers: LspServerConfig[],
  commandExists: (cmd: string) => boolean,
): string[] {
  const tips: string[] = [];
  for (const s of servers) {
    if (s.disabled) continue;
    if (commandExists(s.command)) continue;
    const recipe = recipeForLanguage(s.languageId) || recipeForCommand(s.command);
    const install = recipe?.install[0] || `install \`${s.command}\` on PATH`;
    tips.push(
      `  ${s.languageId}: missing \`${s.command}\` — ${install}`,
    );
  }
  return tips;
}
