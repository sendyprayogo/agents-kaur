import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

// These are permission rules, not an identity assigned to visitors.
const ALLOWED_ID = "18157510";
const ALLOWED_LOGIN = "sendyprayogo";
const ORIGIN = "https://mcp-worker-authenticated.sendy-27a.workers.dev";
const COOKIE = "__Host-kaur-oauth";
const TTL = 600;
type Pending = {
  request: AuthRequest;
  browserHash: string;
  csrfHash?: string;
  verifier?: string;
  expiresAt: number;
};

const app = new Hono<{ Bindings: Env }>();
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),
  (b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hash = async (value: string) => base64url(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value)));
const escape = (value: string) => value.replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const cookie = (value: string, age = TTL) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const browserCookie = (request: Request) => (request.headers.get("Cookie") || "")
  .split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))
  ?.slice(COOKIE.length + 1) || "";

async function readPending(env: Env, key: string, request: Request): Promise<Pending | null> {
  const browser = browserCookie(request);
  if (!browser) return null;
  const record = await env.OAUTH_KV.get<Pending>(key, "json");
  if (!record || record.expiresAt <= Date.now() || record.browserHash !== await hash(browser)) return null;
  return record;
}

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'"
  );
  await next();
});
app.use("/authorize", bodyLimit({ maxSize: 8192 }));
app.use("*", async (c, next) => {
  if (new URL(c.req.url).origin !== ORIGIN || !c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET || !c.env.OAUTH_KV) {
    return c.text("Login belum dikonfigurasi untuk alamat ini.", 503);
  }
  await next();
});

app.get("/", (c) => c.text("Asisten Kaur Faspro. Hubungkan melalui klien MCP pada /mcp. Persetujuan memerlukan login GitHub pemilik."));

app.get("/authorize", async (c) => {
  let request: AuthRequest;
  try { request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw); }
  catch { return c.text("Permintaan OAuth tidak valid.", 400); }
  if (!request.clientId || !request.redirectUri || !request.codeChallenge || request.codeChallengeMethod !== "S256") {
    return c.text("Permintaan OAuth harus menggunakan PKCE S256.", 400);
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
  if (!client || !client.redirectUris?.includes(request.redirectUri)) return c.text("Klien atau alamat kembali tidak valid.", 400);
  const tx = random();
  const csrf = random();
  const browser = random();
  const pending: Pending = { request, browserHash: await hash(browser), csrfHash: await hash(csrf), expiresAt: Date.now() + TTL * 1000 };
  await c.env.OAUTH_KV.put(`kaur:consent:${tx}`, JSON.stringify(pending), { expirationTtl: TTL });
  c.header("Set-Cookie", cookie(browser));
  return c.html(`<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Persetujuan Asisten Kaur</title>
    <style>body{font-family:system-ui;max-width:640px;margin:50px auto;padding:24px;line-height:1.6}button{padding:12px;margin-right:12px}code{overflow-wrap:anywhere}</style>
    <h1>Hubungkan Asisten Kaur Faspro</h1><p>Klien <strong>${escape(client.clientName || request.clientId)}</strong> meminta akses ke alat MCP.</p>
    <p>Alamat kembali: <code>${escape(request.redirectUri)}</code></p>
    <p>Lanjutkan hanya jika Anda memulai permintaan ini. GitHub akan memverifikasi akun pemilik; akun lain ditolak.</p>
    <form method="post" action="/authorize"><input type="hidden" name="tx" value="${tx}"><input type="hidden" name="csrf" value="${csrf}">
    <button name="decision" value="approve">Setujui dan login GitHub</button><button name="decision" value="deny">Batalkan</button></form></html>`);
});

app.post("/authorize", async (c) => {
  //if (c.req.header("Origin") !== ORIGIN) return c.text("Asal permintaan tidak valid.", 403);
  if (c.req.header("Origin") !== ORIGIN) {
  return c.text(
    `Asal permintaan tidak valid. Diterima: ${c.req.header("Origin") || "(kosong)"}. Diharapkan: ${ORIGIN}`,
    403
  );
}
  const form = await c.req.formData();
  const tx = form.get("tx");
  const csrf = form.get("csrf");
  if (typeof tx !== "string" || !/^[a-f0-9]{64}$/.test(tx) || typeof csrf !== "string") return c.text("Formulir tidak valid.", 400);
  const key = `kaur:consent:${tx}`;
  const pending = await readPending(c.env, key, c.req.raw);
  if (!pending || pending.csrfHash !== await hash(csrf)) return c.text("Persetujuan kedaluwarsa atau tidak valid. Mulai ulang dari klien MCP.", 400);
  if (form.get("decision") !== "approve") {
    await c.env.OAUTH_KV.delete(key);
    c.header("Set-Cookie", cookie("", 0));
    return c.text("Permintaan dibatalkan.");
  }
  const state = random();
  const verifier = random();
  const githubPending: Pending = { request: pending.request, browserHash: pending.browserHash, verifier, expiresAt: Date.now() + TTL * 1000 };
  await c.env.OAUTH_KV.put(`kaur:github:${state}`, JSON.stringify(githubPending), { expirationTtl: TTL });
  await c.env.OAUTH_KV.delete(key);
  const target = new URL("https://github.com/login/oauth/authorize");
  target.search = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${ORIGIN}/callback`,
    scope: "read:user",
    state,
    code_challenge: await hash(verifier),
    code_challenge_method: "S256",
    login: ALLOWED_LOGIN,
    allow_signup: "false"
  }).toString();
  return c.redirect(target.href, 302);
});

app.get("/callback", async (c) => {
  const state = c.req.query("state") || "";
  if (!/^[a-f0-9]{64}$/.test(state)) return c.text("State tidak valid.", 400);
  const key = `kaur:github:${state}`;
  const pending = await readPending(c.env, key, c.req.raw);
  if (!pending?.verifier) return c.text("Login kedaluwarsa atau browser tidak cocok. Mulai ulang dari klien MCP.", 400);
  await c.env.OAUTH_KV.delete(key);
  c.header("Set-Cookie", cookie("", 0));
  const code = c.req.query("code");
  if (c.req.query("error") || !code) return c.text("Login GitHub dibatalkan atau gagal.", 400);
  // The temporary GitHub token is only used to verify identity. It is never
  // placed in MCP props, HTML, logs, or the response to the MCP client.
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET,
      code, redirect_uri: `${ORIGIN}/callback`, code_verifier: pending.verifier })
  });
  if (!tokenResponse.ok) return c.text("Verifikasi GitHub gagal. Mulai ulang login.", 502);
  const token = await tokenResponse.json() as { access_token?: string; token_type?: string; error?: string };
  if (token.error || !token.access_token || token.token_type?.toLowerCase() !== "bearer") return c.text("Kode login GitHub tidak valid. Mulai ulang login.", 400);
  const userResponse = await fetch("https://api.github.com/user", {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "Asisten-Kaur-Faspro", "X-GitHub-Api-Version": "2022-11-28" }
  });
  if (!userResponse.ok) return c.text("Identitas GitHub tidak dapat diverifikasi.", 502);
  const user = await userResponse.json() as { id?: number; login?: string };
  if (String(user.id) !== ALLOWED_ID || user.login?.toLowerCase() !== ALLOWED_LOGIN) return c.text("Akses ditolak. Hanya akun GitHub pemilik yang diizinkan.", 403);
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.request,
    userId: String(user.id),
    scope: pending.request.scope,
    metadata: { label: `Asisten Kaur Faspro — ${user.login}` },
    props: { userId: String(user.id), username: user.login, login: user.login }
  });
  return c.redirect(redirectTo, 302);
});

app.onError((_error, c) => c.text("Proses login gagal. Mulai ulang dari klien MCP. Jika berulang, periksa konfigurasi Worker.", 500));
export { app as AuthHandler };
