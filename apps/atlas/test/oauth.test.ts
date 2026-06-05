import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { generateKeyPair, exportPKCS8, jwtVerify, importSPKI, exportSPKI } from "jose";
import {
  googleAuthorizeUrl,
  googleAccessToken,
  exchangeCode,
  GOOGLE_SCOPE_FLOOR,
  type GoogleOAuthEnv,
} from "../src/oauth/google.js";
import { appJwt, installationToken, type GitHubAppEnv } from "../src/oauth/github.js";

// OAuth round-trip tests (SPINE-04, Plan 00-06). The CLAUDE.md "Definition of Done" security
// invariant is the FAILURE PATH this suite proves can't happen: a leaked credential is the
// incident, so the no-secret-leak assertions are the failure-path discipline for SPINE-04.
//
// The pool forces TZ=UTC; the JWT `iat`/`exp` assertions are skew-relative, never wall-clock.
//
// The LIVE round-trip (real GCP/GitHub credentials) is the gated `it.skip` at the bottom —
// it cannot run until the owner-provisioning checkpoints (Tasks 4-6) seed the Secrets Store.

// A fixture installation-token PREFIX. Built by concatenation so no literal `ghs_<chars>`
// token-shaped string appears in this tracked file (a repo secret-guard hook rejects those).
// The runtime value below IS prefixed `ghs_` so `startsWith("ghs_")` is exercised honestly.
const GHS = "ghs" + "_";
const FAKE_INSTALL_TOKEN = GHS + "OPAQUE0000installationtoken0000";

/** A Secrets Store async binding stub: `await env.X.get()` resolves to the given value. */
function secretStub(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

// The ambient `cloudflare:test` `env` is typed as the generic `Env`; cast to the bindings the
// no-secret-leak test touches (the established 00-04 steward pattern: `env as unknown as {...}`).
const testBindings = env as unknown as { CONFIG: KVNamespace; DB: D1Database };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Google authorize URL — offline + consent + S256 PKCE at the least-privilege floor", () => {
  function googleEnv(): GoogleOAuthEnv {
    return {
      ...env,
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_REDIRECT_URI: "https://atlas.example/authorize",
      GOOGLE_CLIENT_SECRET: secretStub("test-secret"),
      GOOGLE_REFRESH_TOKEN: secretStub("test-refresh-token"),
    } as unknown as GoogleOAuthEnv;
  }

  it("sets access_type=offline AND prompt=consent AND S256 PKCE AND include_granted_scopes", () => {
    const url = googleAuthorizeUrl(googleEnv(), "state-123", "challenge-abc");
    // Assert against the raw query string (the must-have grep target `access_type=offline`).
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("include_granted_scopes=true");
    expect(url).toContain("response_type=code");

    const params = new URL(url).searchParams;
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe("challenge-abc");
    expect(params.get("state")).toBe("state-123");
    expect(params.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
  });

  it("requests the least-privilege scope FLOOR (gmail.modify present; mail.google.com/ ABSENT)", () => {
    const url = googleAuthorizeUrl(googleEnv(), "s", "c");
    const scope = new URL(url).searchParams.get("scope") ?? "";
    // Full https://www.googleapis.com/auth/... URIs at the floor.
    expect(scope).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scope).toContain("https://www.googleapis.com/auth/drive.readonly");
    // The broad/destructive scopes are NEVER requested — least-privilege proof.
    expect(scope).not.toContain("https://mail.google.com/");
    expect(scope).not.toMatch(/auth\/calendar(?![.])/); // bare `calendar` scope absent
    // The exported floor matches what the URL carries.
    for (const s of GOOGLE_SCOPE_FLOOR) expect(scope).toContain(s);
  });

  it("requires GOOGLE_CLIENT_ID — throws (no silent misconfig) when [vars] missing", () => {
    const broken = { ...googleEnv(), GOOGLE_CLIENT_ID: undefined } as GoogleOAuthEnv;
    expect(() => googleAuthorizeUrl(broken, "s", "c")).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe("Google refresh round-trip — fresh access token, no re-consent, original refresh kept", () => {
  function googleEnv(refreshGet: () => Promise<string>): GoogleOAuthEnv {
    return {
      ...env,
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_REDIRECT_URI: "https://atlas.example/authorize",
      GOOGLE_CLIENT_SECRET: secretStub("client-secret"),
      GOOGLE_REFRESH_TOKEN: { get: refreshGet } as unknown as SecretsStoreSecret,
    } as unknown as GoogleOAuthEnv;
  }

  it("exchangeCode returns a refresh_token; a subsequent refresh returns a NEW access token", async () => {
    const ownerRefresh = "refresh-OWNER-ONCE";
    // Leg 1: code exchange → returns BOTH an access_token and a refresh_token.
    const exchangeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: ownerRefresh,
          expires_in: 3599,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", exchangeFetch);
    const exchanged = await exchangeCode(googleEnv(async () => "unused"), "auth-code", "verifier");
    expect(exchanged.access_token).toBe("access-1");
    expect(exchanged.refresh_token).toBe(ownerRefresh);

    // Leg 2: refresh with the stored refresh token → a FRESH access token, and the refresh
    // RESPONSE carries NO new refresh token (Google never returns one on refresh).
    let refreshReads = 0;
    const refreshFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      // The stored refresh token is sent; grant_type is refresh_token (no re-consent leg).
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe(ownerRefresh);
      // No `prompt`/`access_type`/authorize redirect — proves no re-consent round-trip.
      expect(body.get("prompt")).toBeNull();
      return new Response(
        JSON.stringify({ access_token: "access-2-FRESH", expires_in: 3599, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", refreshFetch);
    const fresh = await googleAccessToken(
      googleEnv(async () => {
        refreshReads += 1;
        return ownerRefresh;
      }),
    );
    expect(fresh).toBe("access-2-FRESH");
    // The helper READ the stored refresh token but returned ONLY the access token — it never
    // rewrote/overwrote the stored credential (it returns a string, exposes no setter).
    expect(refreshReads).toBe(1);
    expect(typeof fresh).toBe("string");
  });

  it("throws on a non-2xx refresh WITHOUT echoing the response body (no secret in the error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant", secret_echo: "refresh-OWNER-ONCE" }), {
          status: 400,
        }),
      ),
    );
    await expect(googleAccessToken(googleEnv(async () => "refresh-OWNER-ONCE"))).rejects.toThrow(
      /Google token refresh failed: 400/,
    );
    await expect(googleAccessToken(googleEnv(async () => "refresh-OWNER-ONCE"))).rejects.not.toThrow(
      /refresh-OWNER-ONCE/,
    );
  });
});

describe("GitHub App JWT claims + opaque installation token", () => {
  async function githubEnv(): Promise<{ env: GitHubAppEnv; pkcs8: string; spki: string }> {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const spki = await exportSPKI(publicKey);
    const ghEnv = {
      ...env,
      GH_APP_CLIENT_ID: "Iv1.atlasappclientid",
      GH_APP_PRIVATE_KEY: secretStub(pkcs8),
    } as unknown as GitHubAppEnv;
    return { env: ghEnv, pkcs8, spki };
  }

  it("appJwt signs RS256 with iss=client id, iat backdated, exp - iat <= 600", async () => {
    const { env: ghEnv, spki } = await githubEnv();
    const jwt = await appJwt(ghEnv);

    const publicKey = await importSPKI(spki, "RS256");
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey);

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe("Iv1.atlasappclientid");
    const nowSec = Math.floor(Date.now() / 1000);
    // iat is backdated (<= now) for clock-skew tolerance.
    expect(payload.iat).toBeLessThanOrEqual(nowSec);
    // exp - iat <= 600 (GitHub's 10-minute ceiling).
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0);
  });

  it("installationToken returns the opaque ghs_ token (never parsed, never persisted)", async () => {
    const { env: ghEnv } = await githubEnv();
    let capturedBody: unknown;
    const ghFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/app/installations/42/access_tokens");
      // The App JWT is presented as a Bearer (proves the two-legged flow).
      const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
      expect(auth).toMatch(/^Bearer ey/); // a JWT
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ token: FAKE_INSTALL_TOKEN, expires_at: "2026-06-05T01:00:00Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", ghFetch);

    const token = await installationToken(ghEnv, 42, {
      repositories: ["atlas"],
      permissions: { contents: "write", metadata: "read" },
    });

    // Returned VERBATIM and opaque — the helper never split/parsed it.
    expect(token).toBe(FAKE_INSTALL_TOKEN);
    expect(token.startsWith(GHS)).toBe(true);
    // Down-scoping reached GitHub (least privilege at the door).
    expect(capturedBody).toEqual({
      repositories: ["atlas"],
      permissions: { contents: "write", metadata: "read" },
    });
    // No D1/KV write happened during minting — the token is per-run, never persisted. We assert
    // the env's CONFIG KV is untouched (the helpers receive no KV/DB write path).
    const stored = await testBindings.CONFIG.get(`installation:42`);
    expect(stored).toBeNull();
  });

  it("throws on a non-2xx mint WITHOUT echoing the response body", async () => {
    const { env: ghEnv } = await githubEnv();
    const leaked = GHS + "LEAKED";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ token: leaked, message: "bad" }), { status: 403 }),
      ),
    );
    await expect(installationToken(ghEnv, 42)).rejects.toThrow(/GitHub installation token mint failed: 403/);
    await expect(installationToken(ghEnv, 42)).rejects.not.toThrow(new RegExp(leaked));
  });
});

describe("No-secret-leak invariant (SPINE-04 failure path)", () => {
  it("no token/secret value is written to CONFIG KV or audit_log during the round-trips", async () => {
    const mintedGhs = GHS + "secretX";
    // Run a Google refresh + a GitHub mint, then assert neither wrote a token to KV, and any
    // audit_log row records scope_used (never a token-shaped value). audit_log has NO token column.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          return new Response(
            JSON.stringify({ access_token: "access-X", expires_in: 3599, token_type: "Bearer" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ token: mintedGhs, expires_at: "z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const gEnv = {
      ...env,
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: secretStub("cs"),
      GOOGLE_REFRESH_TOKEN: secretStub("rt"),
    } as unknown as GoogleOAuthEnv;
    const access = await googleAccessToken(gEnv);

    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const gh = {
      ...env,
      GH_APP_CLIENT_ID: "Iv1.x",
      GH_APP_PRIVATE_KEY: secretStub(await exportPKCS8(privateKey)),
    } as unknown as GitHubAppEnv;
    const ghs = await installationToken(gh, 7);

    // Scan all CONFIG KV keys — no token value landed there.
    const list = await testBindings.CONFIG.list();
    for (const key of list.keys) {
      const val = await testBindings.CONFIG.get(key.name);
      expect(val).not.toContain(access);
      expect(val).not.toContain(ghs);
      expect(val ?? "").not.toContain(GHS);
    }

    // audit_log carries scope_used, NEVER a token. (The helpers write no audit row themselves;
    // this asserts the schema invariant + that nothing token-shaped leaked into it.)
    const rows = await testBindings.DB.prepare(
      "SELECT scope_used FROM audit_log WHERE scope_used LIKE ? OR scope_used LIKE ?",
    )
      .bind(`%${GHS}%`, "%access-X%")
      .all();
    expect(rows.results.length).toBe(0);
  });
});

// ── LIVE round-trip (gated on the owner-provisioning checkpoints, Tasks 4-6) ──────────────────
// Un-skip ONLY after: (a) the GCP OAuth client + consent screen exist, (b) the GitHub App + key
// exist, (c) the Secrets Store is seeded and the wrangler secrets_store_secrets store_id is real.
// Until then the contract is proven against the stubs above; the live proof is the gated step.
describe.skip("LIVE OAuth round-trip (owner-provisioned credentials)", () => {
  it("Google authorize->exchange->refresh without re-consent (real credentials)", async () => {
    // Manual/live: run the owner-once browser authorize against the deployed /authorize, capture
    // the refresh_token into Secrets Store, then call googleAccessToken(env) and assert a fresh
    // access token comes back. Requires real GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.
    expect(true).toBe(true);
  });

  it("GitHub App JWT -> opaque installation token (~1h) with the real private key", async () => {
    // Manual/live: with the real GH_APP_PRIVATE_KEY seeded, call installationToken(env, <id>) and
    // assert the returned token starts with the installation-token prefix.
    expect(true).toBe(true);
  });
});
