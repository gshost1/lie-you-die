import { createHash } from "node:crypto";
import { cp, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { FileDiff, FileHashes } from "./types.ts";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** All regular files under root, as sorted posix-style relative paths. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function hashTree(root: string): Promise<FileHashes> {
  const hashes: FileHashes = {};
  for (const file of await listFiles(root)) {
    hashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
  }
  return hashes;
}

export function diffHashes(before: FileHashes, after: FileHashes): FileDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [file, hash] of Object.entries(after)) {
    if (!(file in before)) added.push(file);
    else if (before[file] !== hash) modified.push(file);
  }
  for (const file of Object.keys(before)) if (!(file in after)) removed.push(file);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

export function touched(diff: FileDiff): string[] {
  return [...diff.added, ...diff.removed, ...diff.modified].sort();
}

/** True if `file` is `p` itself or sits under directory prefix `p` ("tests/"). */
export function underPath(file: string, p: string): boolean {
  return p.endsWith("/") ? file.startsWith(p) : file === p;
}

export async function copyTree(src: string, dst: string): Promise<void> {
  await cp(src, dst, {
    recursive: true,
    filter: (s) => !s.split(sep).some((part) => SKIP_DIRS.has(part)),
  });
}

export async function readTextOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : null;
}
