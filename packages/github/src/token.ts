import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** GITHUB_TOKEN, else the token of a signed-in `gh`, else null (unauthenticated). */
export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env["GITHUB_TOKEN"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 10_000 });
    const token = stdout.trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}
