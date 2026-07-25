/**
 * Atomic file write: write temp sibling then rename.
 * Prevents truncated files if the process dies mid-write.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  opts?: { encoding?: BufferEncoding; mode?: number },
): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const encoding = opts?.encoding ?? "utf8";
  const mode = opts?.mode;
  try {
    if (typeof content === "string") {
      await fsp.writeFile(tmp, content, { encoding, mode });
    } else {
      await fsp.writeFile(tmp, content, { mode });
    }
    await fsp.rename(tmp, filePath);
    if (mode != null) {
      try {
        await fsp.chmod(filePath, mode);
      } catch {
        /* windows */
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* */
    }
    throw err;
  }
}

export function atomicWriteFileSync(
  filePath: string,
  content: string | Buffer,
  opts?: { encoding?: BufferEncoding; mode?: number },
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    if (typeof content === "string") {
      fs.writeFileSync(tmp, content, {
        encoding: opts?.encoding ?? "utf8",
        mode: opts?.mode,
      });
    } else {
      fs.writeFileSync(tmp, content, { mode: opts?.mode });
    }
    fs.renameSync(tmp, filePath);
    if (opts?.mode != null) {
      try {
        fs.chmodSync(filePath, opts.mode);
      } catch {
        /* */
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* */
    }
    throw err;
  }
}
