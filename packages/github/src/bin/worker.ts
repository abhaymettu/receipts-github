import { appJwt, installationToken, verifySignature } from "../app/auth.ts";
import { checkTarget } from "../app/check.ts";
import { targets, type Target } from "../app/events.ts";
import { gitHub } from "../client.ts";

/** Set with `wrangler secret put` (PRIVATE_KEY, WEBHOOK_SECRET) and `[vars]` in wrangler.toml (APP_ID). */
export interface Env {
  readonly APP_ID: string;
  readonly PRIVATE_KEY: string;
  readonly WEBHOOK_SECRET: string;
}

export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

const HOME = "https://github.com/abhaymettu/receipts-github";
/** A pull request's own CI starts with it; waiting this long lets its runs appear before the first verdict. */
export const SETTLE_MS = 20_000;

async function handle(target: Target, env: Env, settleMs: number): Promise<void> {
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  const where = `${target.pull.owner}/${target.pull.repo}#${target.pull.number}@${target.sha.slice(0, 7)}`;
  try {
    const jwt = await appJwt({ appId: env.APP_ID, privateKey: env.PRIVATE_KEY, now: Date.now() });
    const token = await installationToken(gitHub({ token: jwt }), target.installationId);
    const outcome = await checkTarget({ github: gitHub({ token }), target, appId: Number(env.APP_ID) });
    console.log(JSON.stringify({ where, ...outcome }));
  } catch (error) {
    console.error(JSON.stringify({ where, error: error instanceof Error ? error.message : String(error) }));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") return Response.redirect(HOME, 302);
    if (request.method !== "POST" || pathname !== "/webhook") return new Response("Not found\n", { status: 404 });

    if (!env.WEBHOOK_SECRET || !env.PRIVATE_KEY) return new Response("The App's secrets are not set\n", { status: 503 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
      return new Response("Bad signature\n", { status: 401 });
    }
    const event = request.headers.get("x-github-event") ?? "";
    const queued = targets(event, JSON.parse(new TextDecoder().decode(body)), Number(env.APP_ID));
    const settleMs = event === "pull_request" ? SETTLE_MS : 0;
    ctx.waitUntil(Promise.all(queued.map((target) => handle(target, env, settleMs))));
    return new Response(`${event}: ${queued.length} pull request(s) to check\n`, { status: 202 });
  },
};
