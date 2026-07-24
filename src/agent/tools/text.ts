/** BOM + line-ending helpers (OpenCode pattern). */

export type LineEnding = "\n" | "\r\n";

export function detectLineEnding(text: string): LineEnding {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function toLineEnding(text: string, ending: LineEnding): string {
  const n = normalizeNewlines(text);
  return ending === "\n" ? n : n.replace(/\n/g, "\r\n");
}

export interface BomSplit {
  bom: string;
  text: string;
}

export function splitBom(text: string): BomSplit {
  if (text.charCodeAt(0) === 0xfeff) {
    return { bom: "\uFEFF", text: text.slice(1) };
  }
  return { bom: "", text };
}

export function joinBom(text: string, bom: string): string {
  return bom ? bom + text : text;
}
