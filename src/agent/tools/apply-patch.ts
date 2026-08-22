/**
 * apply_patch tool — multi-file add/update/delete/move in one call.
 * OpenCode / Codex-compatible patch grammar.
 * All hunks are validated before any write; a mid-apply failure rolls back.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath, displayRelPath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { applyUpdateChunks, parsePatch } from "./patch.js";
import { shortDiff } from "./edit-match.js";
import {
  afterWriteText,
  buildPatchReceipt,
  editReceiptEnabled,
  type PatchOpReceipt,
} from "./edit-receipt.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  formatNoteSuffix,
  maybeFormatAfterWrite,
} from "./format-on-write.js";
import { fileReadGuardEnabled } from "./file-read-state.js";
import { verifyHintSuffix } from "../../util/project-intel.js";
import { applyRawPinSideEffects } from "../../util/pin-budget.js";

async function unlinkIfExists(abs: string): Promise<void> {
  try {
    await fsp.unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function restoreTextFile(
  abs: string,
  content: string,
  mode?: number,
): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await atomicWriteFile(abs, content, mode != null ? { mode } : undefined);
}

type PatchJournal = {
  path: string;
  kind: "create" | "update" | "delete";
  before?: string;
  mode?: number;
  skipped?: boolean;
  reason?: string;
};

function journalPreimage(
  kind: "update" | "delete",
  abs: string,
  before: string,
  mode?: number,
): PatchJournal {
  const bytes = Buffer.byteLength(before, "utf8");
  if (bytes > 1_500_000) {
    return {
      path: abs,
      kind,
      mode,
      skipped: true,
      reason: `pre-image ${bytes} bytes exceeds journal cap`,
    };
  }
  return { path: abs, kind, before, mode };
}

export async function toolApplyPatch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rawPatch = args.patchText ?? args.patch_text ?? args.patch;
  if (rawPatch != null && typeof rawPatch !== "string") {
    const kind =
      rawPatch === null
        ? "null"
        : Array.isArray(rawPatch)
          ? "array"
          : typeof rawPatch;
    return {
      output: `apply_patch error: patchText must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const patchText = String(rawPatch ?? "");
  if (!patchText.trim()) {
    return {
      output:
        "apply_patch error: patchText is required (non-empty string).\n" +
        "Example: *** Begin Patch\n*** Update File: path.ts\n@@\n-old\n+new\n*** End Patch\n" +
        "Whitespace-only patchText fails closed. Prefer search_replace for a single small edit.",
      isError: true,
    };
  }

  const parsed = parsePatch(patchText);
  if (!parsed.ok) {
    const detail = parsed.error || "invalid patch";
    const tip =
      /Begin Patch|Update File|Add File|grammar|hunk/i.test(detail)
        ? ""
        : "\nHint: wrap ops in *** Begin Patch / *** End Patch with *** Add/Update/Delete File: path hunks.";
    return {
      output: `apply_patch verification failed: ${detail}${tip}`,
      isError: true,
    };
  }

  type Planned =
    | {
        kind: "add";
        rel: string;
        abs: string;
        content: string;
      }
    | {
        kind: "delete";
        rel: string;
        abs: string;
        before: string;
        /** Pre-image permission bits for the undo journal. */
        mode?: number;
      }
    | {
        kind: "update";
        rel: string;
        abs: string;
        content: string;
        before: string;
        /** Pre-image permission bits for the undo journal. */
        mode?: number;
        moveRel?: string;
        moveAbs?: string;
      };

  const planned: Planned[] = [];
  /** Paths this patch will create (add or move-dest) — for same-batch clobber checks. */
  const willCreate = new Set<string>();
  /** Paths this patch will delete (delete or move-source). */
  const willDelete = new Set<string>();

  const pathOccupied = (abs: string): boolean => {
    if (willCreate.has(abs)) return true;
    if (willDelete.has(abs)) return false;
    return fs.existsSync(abs);
  };

  // Validate + prepare all ops before mutating disk (fail closed on first bad hunk)
  for (const hunk of parsed.hunks) {
    if (hunk.type === "add") {
      const logical = resolvePath(ctx.workspace, hunk.path);
      let abs: string;
      try {
        abs = await assertWritablePath(ctx.workspace, logical);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      if (pathOccupied(abs)) {
        let kind = "path";
        try {
          if (fs.existsSync(abs)) {
            kind = fs.statSync(abs).isDirectory() ? "directory" : "file";
          } else if (willCreate.has(abs)) {
            kind = "file";
          }
        } catch {
          /* keep generic */
        }
        return {
          output:
            kind === "directory"
              ? `apply_patch failed: cannot add ${hunk.path} — path is an existing directory (use a file path inside it)`
              : willCreate.has(abs)
                ? `apply_patch failed: cannot add ${hunk.path} — path is already created earlier in this patch`
                : `apply_patch failed: cannot add existing file ${hunk.path}`,
          isError: true,
        };
      }
      let content = hunk.contents;
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      planned.push({
        kind: "add",
        rel: displayRelPath(ctx.workspace, abs),
        abs,
        content,
      });
      willCreate.add(abs);
      willDelete.delete(abs);
      continue;
    }

    if (hunk.type === "delete") {
      const logical = resolvePath(ctx.workspace, hunk.path);
      let abs: string;
      try {
        abs = await assertWritablePath(ctx.workspace, logical);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      // Allow delete of a path added earlier in this patch (rare but valid).
      const fromDisk = fs.existsSync(abs) && !willDelete.has(abs);
      const fromBatch = willCreate.has(abs);
      if (!fromDisk && !fromBatch) {
        const hint = await pathNotFoundHint(logical, ctx.workspace);
        return {
          output: `apply_patch failed: delete target missing: ${hunk.path}${hint ? `\n${hint}` : ""}`,
          isError: true,
        };
      }
      if (fromDisk) {
        const st = await fsp.stat(abs);
        if (st.isDirectory()) {
          return {
            output: `apply_patch failed: refuse to delete directory ${hunk.path}`,
            isError: true,
          };
        }
      }
      let before = "";
      let preMode: number | undefined;
      if (fromDisk) {
        try {
          before = await fsp.readFile(abs, "utf8");
          preMode = fs.statSync(abs).mode & 0o777;
        } catch (err) {
          return {
            output: `apply_patch failed: cannot read ${hunk.path} for delete: ${(err as Error).message}`,
            isError: true,
          };
        }
      } else {
        // Deleting a same-batch add — recover content from planned add
        const addOp = planned.find((p) => p.kind === "add" && p.abs === abs);
        if (addOp && addOp.kind === "add") before = addOp.content;
      }
      planned.push({
        kind: "delete",
        rel: displayRelPath(ctx.workspace, abs),
        abs,
        before,
        mode: preMode,
      });
      willDelete.add(abs);
      willCreate.delete(abs);
      continue;
    }

    // update
    const logical = resolvePath(ctx.workspace, hunk.path);
    let abs: string;
    try {
      abs = await assertWritablePath(ctx.workspace, logical);
    } catch (err) {
      return { output: (err as Error).message, isError: true };
    }
    const srcOnDisk = fs.existsSync(abs) && !willDelete.has(abs);
    const srcFromBatch = willCreate.has(abs);
    if (!srcOnDisk && !srcFromBatch) {
      const hint = await pathNotFoundHint(logical, ctx.workspace);
      return {
        output: `apply_patch failed: update target missing: ${hunk.path}${hint ? `\n${hint}` : ""}`,
        isError: true,
      };
    }
    try {
      if (srcOnDisk && fs.statSync(abs).isDirectory()) {
        return {
          output: `apply_patch failed: update target is a directory: ${hunk.path} (pass a file path)`,
          isError: true,
        };
      }
    } catch {
      /* fall through to read */
    }
    let original: string;
    let preMode: number | undefined;
    try {
      if (srcOnDisk) {
        original = await fsp.readFile(abs, "utf8");
        try {
          preMode = fs.statSync(abs).mode & 0o777;
        } catch {
          preMode = undefined;
        }
      } else {
        const addOp = planned.find((p) => p.kind === "add" && p.abs === abs);
        original = addOp && addOp.kind === "add" ? addOp.content : "";
      }
    } catch (err) {
      return {
        output: `apply_patch failed: cannot read ${hunk.path}: ${(err as Error).message}`,
        isError: true,
      };
    }
    let next: string;
    try {
      next = applyUpdateChunks(original, hunk.path, hunk.chunks);
    } catch (err) {
      return {
        output: `apply_patch failed on ${hunk.path}: ${(err as Error).message}`,
        isError: true,
      };
    }
    let moveAbs: string | undefined;
    let moveRel: string | undefined;
    if (hunk.movePath) {
      const moveLogical = resolvePath(ctx.workspace, hunk.movePath);
      try {
        moveAbs = await assertWritablePath(ctx.workspace, moveLogical);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      moveRel = displayRelPath(ctx.workspace, moveAbs);
      // Fail closed on clobber — disk OR earlier hunk in this same patch.
      if (moveAbs !== abs && pathOccupied(moveAbs)) {
        let kind = "path";
        try {
          if (fs.existsSync(moveAbs) && !willDelete.has(moveAbs)) {
            kind = fs.statSync(moveAbs).isDirectory() ? "directory" : "file";
          }
        } catch {
          /* keep generic */
        }
        const sameBatch = willCreate.has(moveAbs);
        return {
          output:
            kind === "directory"
              ? `apply_patch failed: move destination is a directory: ${hunk.movePath} (use a file path)`
              : sameBatch
                ? `apply_patch failed: move destination already created earlier in this patch: ${hunk.movePath}`
                : `apply_patch failed: move destination already exists: ${hunk.movePath} (delete/rename it first, or update in place)`,
          isError: true,
        };
      }
    }
    planned.push({
      kind: "update",
      rel: displayRelPath(ctx.workspace, abs),
      abs,
      content: next,
      before: original,
      mode: preMode,
      moveAbs,
      moveRel,
    });
    if (moveAbs && moveAbs !== abs) {
      willDelete.add(abs);
      willCreate.delete(abs);
      willCreate.add(moveAbs);
      willDelete.delete(moveAbs);
    }
  }

  const journal = (
    input: {
      path: string;
      kind: "create" | "update" | "delete";
      before?: string;
      mode?: number;
      skipped?: boolean;
      reason?: string;
    },
  ) => {
    try {
      ctx.recordMutation?.(input);
    } catch {
      /* best-effort */
    }
  };

  // Session-scoped stale/unread guard for update/delete of existing files.
  if (ctx.fileReads && fileReadGuardEnabled()) {
    for (const op of planned) {
      if (op.kind === "add") continue;
      const blocked = await ctx.fileReads.checkBeforeMutate(op.abs, {
        tool: "apply_patch",
        rel: op.rel,
      });
      if (blocked) {
        return { output: blocked, isError: true };
      }
    }
  }

  const applied: string[] = [];
  /** Absolute paths successfully written (for opt-in format-on-write). */
  const writtenAbs: string[] = [];
  const pendingJournals: PatchJournal[] = [];
  const rollbacks: Array<{ label: string; undo: () => Promise<void> }> = [];
  try {
    for (const op of planned) {
      if (op.kind === "add") {
        await fsp.mkdir(path.dirname(op.abs), { recursive: true });
        await atomicWriteFile(op.abs, op.content);
        rollbacks.push({
          label: `A ${op.rel}`,
          undo: () => unlinkIfExists(op.abs),
        });
        applied.push(`A ${op.rel}`);
        writtenAbs.push(op.abs);
        pendingJournals.push({ path: op.abs, kind: "create" });
      } else if (op.kind === "delete") {
        await fsp.unlink(op.abs);
        rollbacks.push({
          label: `D ${op.rel}`,
          undo: () => restoreTextFile(op.abs, op.before, op.mode),
        });
        applied.push(`D ${op.rel}`);
        pendingJournals.push(
          journalPreimage("delete", op.abs, op.before, op.mode),
        );
      } else if (op.moveAbs && op.moveAbs !== op.abs) {
        // Move = create dest then delete source. Push rollback after each
        // disk step so a failure between them still unwinds.
        const moveAbs = op.moveAbs;
        await fsp.mkdir(path.dirname(moveAbs), { recursive: true });
        await atomicWriteFile(moveAbs, op.content);
        rollbacks.push({
          label: `A ${op.moveRel}`,
          undo: () => unlinkIfExists(moveAbs),
        });
        await fsp.unlink(op.abs);
        rollbacks.push({
          label: `D ${op.rel}`,
          undo: () => restoreTextFile(op.abs, op.before, op.mode),
        });
        applied.push(`M ${op.rel} → ${op.moveRel}`);
        writtenAbs.push(moveAbs);
        pendingJournals.push({ path: moveAbs, kind: "create" });
        pendingJournals.push(
          journalPreimage("delete", op.abs, op.before, op.mode),
        );
      } else {
        await atomicWriteFile(op.abs, op.content);
        rollbacks.push({
          label: `M ${op.rel}`,
          undo: () => restoreTextFile(op.abs, op.before, op.mode),
        });
        applied.push(`M ${op.rel}`);
        writtenAbs.push(op.abs);
        pendingJournals.push(
          journalPreimage("update", op.abs, op.before, op.mode),
        );
      }
    }
  } catch (err) {
    const undoFailed: string[] = [];
    for (const rb of [...rollbacks].reverse()) {
      try {
        await rb.undo();
      } catch (undoErr) {
        undoFailed.push(`${rb.label}: ${(undoErr as Error).message}`);
      }
    }
    const head = `apply_patch failed after ${applied.length} op(s): ${(err as Error).message}`;
    const detail = applied.length
      ? `Attempted before failure:\n${applied.join("\n")}\n`
      : "";
    const tail = undoFailed.length
      ? `Rollback incomplete — inspect the workspace:\n${undoFailed.join("\n")}`
      : "Rolled back — workspace is unchanged.";
    return {
      output: `${head}\n${detail}${tail}`,
      isError: true,
    };
  }

  for (const entry of pendingJournals) journal(entry);
  for (let i = 0; i < planned.length; i++) ctx.onEdit?.();
  if (ctx.fileReads && fileReadGuardEnabled()) {
    for (const op of planned) {
      if (op.kind === "delete") ctx.fileReads.clear(op.abs);
      else if (op.kind === "update" && op.moveAbs && op.moveAbs !== op.abs) {
        ctx.fileReads.clear(op.abs);
      }
    }
  }

  const fmtByAbs = new Map<string, ReturnType<typeof maybeFormatAfterWrite>>();
  const fmtNotes: string[] = [];
  for (const target of writtenAbs) {
    const fr = maybeFormatAfterWrite(target, ctx.workspace);
    fmtByAbs.set(target, fr);
    const note = formatNoteSuffix(fr);
    if (note) {
      const rel = displayRelPath(ctx.workspace, target);
      fmtNotes.push(`${rel}${note}`);
    }
  }
  // Note AFTER format-on-write so chained edits see the final mtime/size.
  if (ctx.fileReads && fileReadGuardEnabled()) {
    for (const target of writtenAbs) {
      await ctx.fileReads.noteFromDisk(target);
    }
  }
  const pinNotes: string[] = [];
  for (const op of planned) {
    if (op.kind === "delete") continue;
    const dest =
      op.kind === "update" && op.moveAbs ? op.moveAbs : op.abs;
    const before = op.kind === "add" ? "" : op.before;
    const warn = applyRawPinSideEffects({
      cwd: ctx.workspace,
      absPath: dest,
      before,
      after: op.content,
      sessionId: ctx.sessionId,
      session: ctx.session,
    });
    if (warn) pinNotes.push(warn);
  }
  const verifyTip =
    (writtenAbs.some((p) => {
      const e = path.extname(p).toLowerCase();
      return e !== ".md" && e !== ".mdx" && e !== ".txt" && e !== ".rst";
    })
      ? verifyHintSuffix(ctx.workspace, writtenAbs[0])
      : "") +
    (pinNotes.length ? `\n\n${[...new Set(pinNotes)].join("\n\n")}` : "");

  const diffBlock = planned.length
    ? "\n\n" +
      planned
        .map((op) =>
          op.kind === "add"
            ? shortDiff(op.rel, "", op.content, 30)
            : op.kind === "delete"
              ? shortDiff(op.rel, op.before, "", 30)
              : shortDiff(op.moveRel && op.moveAbs !== op.abs ? `${op.rel} → ${op.moveRel}` : op.rel, op.before, op.content, 30),
        )
        .join("\n")
    : "";

  if (!editReceiptEnabled()) {
    return {
      output:
        `Applied patch (${applied.length} op(s)):\n${applied.join("\n")}` +
        (fmtNotes.length ? `\n${fmtNotes.join("\n")}` : "") +
        diffBlock +
        verifyTip,
      diff: diffBlock.trim(),
    };
  }

  const ops: PatchOpReceipt[] = planned.map((op) => {
    if (op.kind === "delete") {
      return {
        kind: "delete",
        rel: op.rel,
        before: op.before,
        after: "",
      };
    }
    const dest = op.kind === "update" && op.moveAbs ? op.moveAbs : op.abs;
    const destRel =
      op.kind === "update" && op.moveRel ? op.moveRel : op.rel;
    const resolved = afterWriteText(dest, op.content, fmtByAbs.get(dest) ?? null);
    return {
      kind: op.kind === "add" ? "add" : "update",
      rel: op.rel,
      moveRel:
        op.kind === "update" && op.moveRel && op.moveAbs !== op.abs
          ? destRel
          : undefined,
      before: op.kind === "add" ? "" : op.before,
      after: resolved.after,
      formatted: resolved.formatted,
      formatSkipped: resolved.formatSkipped,
    };
  });

  return buildPatchReceipt({ ops, verifyTip });
}
