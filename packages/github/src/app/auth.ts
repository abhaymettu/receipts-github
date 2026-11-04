import { z } from "zod";
import type { GitHub } from "../client.ts";

const encoder = new TextEncoder();
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/** Whether `header` (X-Hub-Signature-256) is the HMAC of `body` under the webhook secret. */
export async function verifySignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  const hex = SIGNATURE.exec(header ?? "")?.[1];
  if (hex === undefined) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const expected = new Uint8Array(hex.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);
  return crypto.subtle.verify("HMAC", key, expected, body);
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("the App private key is PKCS#1; store `openssl pkcs8 -topk8 -nocrypt` of it instead");
  }
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

/** The RS256 JWT a GitHub App signs to act as itself; GitHub accepts at most ten minutes. */
export async function appJwt({ appId, privateKey, now }: { appId: string; privateKey: string; now: number }): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const head = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(encoder.encode(JSON.stringify({ iat, exp: iat + 540, iss: appId })));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${head}.${claims}`));
  return `${head}.${claims}.${base64url(new Uint8Array(signature))}`;
}

const AccessToken = z.object({ token: z.string() });

/** A token scoped to one installation, from a client that holds the App JWT. */
export async function installationToken(asApp: GitHub, installationId: number): Promise<string> {
  return AccessToken.parse(await asApp.post(`/app/installations/${installationId}/access_tokens`, {})).token;
}
