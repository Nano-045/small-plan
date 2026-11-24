import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorized } from "../src/auth.ts";
test("signed Access JWT requires correct human or service identity, issuer, audience and expiry", async () => {
  const issuer = "https://example.cloudflareaccess.com",
    env = {
      ACCESS_ISSUER: issuer,
      ACCESS_AUD: "user-app",
      BRIDGE_AUD: "bridge-app",
      ALLOWED_EMAIL: "owner@example.com",
      BRIDGE_CLIENT_ID: "service.access",
    };
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const resolve = () => createLocalJWKSet({ keys: [jwk] });
  async function check(
    claims,
    aud,
    bridge = false,
    expiry = "1h",
    iss = issuer,
  ) {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
    return authorized(
      new Request("https://smallplan.example/", {
        headers: { "cf-access-jwt-assertion": token },
      }),
      env,
      bridge,
      resolve,
    );
  }
  assert.equal(await check({ email: "owner@example.com" }, "user-app"), true);
  assert.equal(await check({ email: "other@example.com" }, "user-app"), false);
  assert.equal(
    await check({ common_name: "service.access" }, "bridge-app", true),
    true,
  );
  assert.equal(
    await check({ email: "owner@example.com" }, "user-app", true),
    false,
  );
  assert.equal(
    await check({ common_name: "service.access" }, "bridge-app"),
    false,
  );
  assert.equal(
    await check({ email: "owner@example.com" }, "user-app", false, "-1h"),
    false,
  );
  assert.equal(
    await check(
      { email: "owner@example.com" },
      "user-app",
      false,
      "1h",
      "https://other.cloudflareaccess.com",
    ),
    false,
  );
});
