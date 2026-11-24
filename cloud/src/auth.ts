import { createRemoteJWKSet, jwtVerify } from "jose";

const keys = new Map();
export async function authorized(request, env, bridge, resolveKeys = remote) {
  const issuer = env.ACCESS_ISSUER;
  const audience = bridge ? env.BRIDGE_AUD : env.ACCESS_AUD;
  const identity = bridge ? env.BRIDGE_CLIENT_ID : env.ALLOWED_EMAIL;
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || "") ||
    !audience ||
    !identity ||
    env.BRIDGE_AUD === env.ACCESS_AUD
  )
    return false;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, resolveKeys(issuer), {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    return bridge
      ? payload.common_name === identity && !payload.email
      : typeof payload.email === "string" &&
          payload.email.toLowerCase() === identity.toLowerCase() &&
          !payload.common_name;
  } catch {
    return false;
  }
}

function remote(issuer) {
  if (!keys.has(issuer))
    keys.set(
      issuer,
      createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs")),
    );
  return keys.get(issuer);
}
