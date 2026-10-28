import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validRedirect } from "../src/oauth-server/redirect.js";
import { OAuthServer } from "../src/oauth-server/server.js";

test("validRedirect", () => {
  assert.ok(validRedirect("https://x.com/cb"));
  assert.ok(validRedirect("http://localhost:3000/cb"));
  assert.ok(validRedirect("myapp://cb"));
  assert.ok(!validRedirect("http://evil.com/cb"));
  assert.ok(!validRedirect("javascript:alert(1)"));
  assert.ok(!validRedirect("https://x.com/cb#frag"));
});

test("OAuthServer: alur register -> authorize -> token -> refresh -> verify -> revoke", () => {
  const oauth = new OAuthServer({
    issuer: "http://localhost:1",
    password: "pw",
    storePath: join(mkdtempSync(join(tmpdir(), "gw-")), "o.json"),
    accessTtl: 60,
    refreshTtl: 120,
  });

  const reg = oauth.register({ redirect_uris: ["http://localhost:9/cb"] });
  assert.ok("ok" in reg);
  const clientId = (reg as any).ok.client_id as string;

  const verifier = "v".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
  });
  const start = oauth.beginAuthorize(q) as any;
  assert.ok(start.txn);

  assert.equal(oauth.approve(start.txn, "salah", "1.1.1.1").kind, "wrong");
  const ok = oauth.approve(start.txn, "pw", "1.1.1.1") as any;
  assert.equal(ok.kind, "ok");
  const code = new URL(ok.location).searchParams.get("code")!;

  const bad = oauth.token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: "x".repeat(50) });
  assert.equal(bad.status, 400); // PKCE salah, dan code sekali pakai

  // alur ulang untuk verifier yang benar
  const start2 = oauth.beginAuthorize(q) as any;
  const code2 = new URL((oauth.approve(start2.txn, "pw", "1.1.1.1") as any).location).searchParams.get("code")!;
  const tok = oauth.token({ grant_type: "authorization_code", client_id: clientId, code: code2, code_verifier: verifier });
  assert.equal(tok.status, 200);
  const access = tok.body.access_token as string;
  assert.ok(oauth.verify(access));

  const refreshed = oauth.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tok.body.refresh_token as string });
  assert.equal(refreshed.status, 200);
  // refresh token berputar: pemakaian kedua gagal
  assert.equal(oauth.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tok.body.refresh_token as string }).status, 400);

  oauth.revoke(access);
  assert.ok(!oauth.verify(access));
});

test("OAuthServer: 5 password salah mengunci IP", () => {
  const oauth = new OAuthServer({
    issuer: "http://localhost:1",
    password: "pw",
    storePath: join(mkdtempSync(join(tmpdir(), "gw-")), "o.json"),
    accessTtl: 60,
    refreshTtl: 120,
  });
  const clientId = ((oauth.register({ redirect_uris: ["http://localhost:9/cb"] }) as any).ok.client_id) as string;
  const challenge = createHash("sha256").update("v".repeat(50)).digest("base64url");
  const q = new URLSearchParams({ client_id: clientId, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
  const txn = (oauth.beginAuthorize(q) as any).txn as string;
  for (let i = 0; i < 5; i++) assert.equal(oauth.approve(txn, "x", "2.2.2.2").kind, "wrong");
  assert.equal(oauth.approve(txn, "pw", "2.2.2.2").kind, "locked");
});
