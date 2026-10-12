import { sign, verify } from "node:crypto";
import type { ApnsSigningKey } from "./signing-key";
import type { ApnsVerificationKey } from "./verification-key";

function base64UrlEncode(data: string | Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function base64UrlDecode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new TypeError("Token segment is not base64url-encoded.");
  }
  return Buffer.from(segment, "base64url");
}

function parseJsonObject(segment: string, what: string): Record<string, unknown> {
  const text = base64UrlDecode(segment).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`Could not parse ${what} as a JSON object: ${text}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`Could not parse ${what} as a JSON object: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * A JSON Web Token (ES256) that authenticates a provider to the APNs gateway when using token-based authentication.
 *
 * Tokens are signed with standard JWS (IEEE P1363, `r || s`) signatures. When verifying, DER-encoded signatures, as
 * produced by Java's `SHA256withECDSA` (and therefore by Pushy), are accepted too.
 */
export class AuthenticationToken {
  readonly keyId: string;
  readonly teamId: string;
  readonly issuedAt: Date;
  /** The compact, base64url-encoded token. */
  readonly encoded: string;
  private readonly signature: Buffer;

  private constructor(keyId: string, teamId: string, issuedAt: Date, encoded: string, signature: Buffer) {
    this.keyId = keyId;
    this.teamId = teamId;
    this.issuedAt = issuedAt;
    this.encoded = encoded;
    this.signature = signature;
  }

  /** Creates and signs a new token. */
  static create(signingKey: ApnsSigningKey, issuedAt: Date = new Date()): AuthenticationToken {
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: signingKey.keyId }));
    const claims = base64UrlEncode(JSON.stringify({ iss: signingKey.teamId, iat: issuedAtSeconds }));
    const signingInput = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
      key: signingKey.privateKey,
      dsaEncoding: "ieee-p1363",
    });

    return new AuthenticationToken(
      signingKey.keyId,
      signingKey.teamId,
      new Date(issuedAtSeconds * 1000),
      `${signingInput}.${base64UrlEncode(signature)}`,
      signature,
    );
  }

  /**
   * Parses an encoded token without verifying its signature.
   *
   * @throws TypeError if the token is malformed
   */
  static parse(encoded: string): AuthenticationToken {
    if (encoded == null) throw new TypeError("Encoded token must not be null.");

    const segments = encoded.split(".");
    if (segments.length !== 3) {
      throw new TypeError("Authentication tokens must have exactly three segments.");
    }

    const [headerSegment, claimsSegment, signatureSegment] = segments as [string, string, string];
    const header: { kid?: unknown } = parseJsonObject(headerSegment, "header");
    const claims: { iss?: unknown; iat?: unknown } = parseJsonObject(claimsSegment, "claims");

    if (typeof header.kid !== "string") {
      throw new TypeError('Header must map a string value to the "kid" key.');
    }
    if (typeof claims.iss !== "string") {
      throw new TypeError('Claims must map a string value to the "iss" key.');
    }
    if (typeof claims.iat !== "number" || !Number.isInteger(claims.iat)) {
      throw new TypeError('Claims must map an integer value to the "iat" key.');
    }

    return new AuthenticationToken(
      header.kid,
      claims.iss,
      new Date(claims.iat * 1000),
      encoded,
      base64UrlDecode(signatureSegment),
    );
  }

  /** The value of the `authorization` header carrying this token. */
  get authorizationHeader(): string {
    return `bearer ${this.encoded}`;
  }

  /**
   * Checks that the token was issued for the verification key's key and team and that its signature is valid.
   */
  verifySignature(verificationKey: ApnsVerificationKey): boolean {
    if (this.keyId !== verificationKey.keyId || this.teamId !== verificationKey.teamId) {
      return false;
    }

    const signingInput = Buffer.from(this.encoded.slice(0, this.encoded.lastIndexOf(".")), "utf8");
    const dsaEncoding = this.signature.length === 64 ? "ieee-p1363" : "der";

    try {
      return verify("sha256", signingInput, { key: verificationKey.publicKey, dsaEncoding }, this.signature);
    } catch {
      return false;
    }
  }

  toString(): string {
    return this.encoded;
  }
}
