/** The claims jose's `JWTPayload` names, as it types them. */
export type JwtClaims = { iss?: string; sub?: string; aud?: string | string[]; jti?: string; nbf?: number; exp?: number; iat?: number; [claim: string]: unknown }

/**
 * A JWT's claims, without checking its signature: what jose's `decodeJwt` does, here so that reading a
 * token's `exp` or `owner_id` doesn't load jose (275 KB in 129 modules) on every CLI command. Tokens are
 * signed and verified elsewhere, with jose, which those paths import when they run.
 */
export function decodeJwt(jwt: string): JwtClaims {
  if (typeof jwt !== 'string') throw new TypeError('JWTs must use Compact JWS serialization, JWT must be a string')
  const parts = jwt.split('.')
  if (parts.length === 5) throw new TypeError('Only JWTs using Compact JWS serialization can be decoded')
  if (parts.length !== 3) throw new TypeError('Invalid JWT')
  if (!parts[1]) throw new TypeError('JWTs must contain a payload')
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new TypeError('Failed to parse the decoded payload as JSON')
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new TypeError('Invalid JWT Claims Set')
  return claims as JwtClaims
}
