import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_TOOLS = ["bun", "bunx", "node", "npm", "npx", "git"];
const LOGGER = join(import.meta.dir, "log.ts");

/**
 * Local command log for fake agents (and local smoke runs of real agents).
 * Writes one wrapper per tool into binDir; each runs the real binary, then logs
 * argv + exit code to logPath. Returns a PATH with binDir first.
 *
 * Not tamper-proof: a process can call a binary by absolute path, or edit
 * PATH. That is why VM runs use the root-side tracer instead.
 */
export async function installShim(binDir: string, logPath: string, basePath = process.env.PATH ?? ""): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const realBun = process.execPath;
  for (const tool of DEFAULT_TOOLS) {
    const real = Bun.which(tool, { PATH: basePath });
    if (!real) continue;
    const script = `#!/bin/sh
${q(real)} "$@"
code=$?
${q(realBun)} ${q(LOGGER)} ${q(logPath)} "$code" "$PWD" ${q(tool)} "$@" >/dev/null 2>&1
exit $code
`;
    const path = join(binDir, tool);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  return `${binDir}:${basePath}`;
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
