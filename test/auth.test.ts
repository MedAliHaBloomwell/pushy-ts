import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { ApnsSigningKey, ApnsVerificationKey, AuthenticationToken } from "../src";
import { AuthenticationTokenProvider } from "../src/auth/token-provider";
import { fixture, fixturePath, KEY_ID, signingKey, TEAM_ID, verificationKey } from "./helpers";

const decodeSegment = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

describe("ApnsSigningKey", () => {
  test("loads a .p8 file", async () => {
    const key = await ApnsSigningKey.loadFromPkcs8File(fixturePath("token-auth-private-key.p8"), TEAM_ID, KEY_ID);
    expect(key.teamId).toBe(TEAM_ID);
    expect(key.keyId).toBe(KEY_ID);
    expect(key.privateKey.asymmetricKeyType).toBe("ec");

    const syncKey = ApnsSigningKey.loadFromPkcs8FileSync(fixturePath("token-auth-private-key.p8"), TEAM_ID, KEY_ID);
    expect(syncKey.privateKey.export({ format: "jwk" })).toEqual(key.privateKey.export({ format: "jwk" }));
  });

  test("loads keys stored in environment variables", () => {
    const pem = fixture("token-auth-private-key.p8").toString("utf8");
    const expected = signingKey.privateKey.export({ format: "jwk" });

    const escaped = pem.replace(/\n/g, "\\n");
    expect(ApnsSigningKey.loadFromPkcs8(escaped, TEAM_ID, KEY_ID).privateKey.export({ format: "jwk" })).toEqual(expected);

    const bareBase64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect(ApnsSigningKey.loadFromPkcs8(bareBase64, TEAM_ID, KEY_ID).privateKey.export({ format: "jwk" })).toEqual(
      expected,
    );

    const der = signingKey.privateKey.export({ format: "der", type: "pkcs8" });
    expect(ApnsSigningKey.loadFromPkcs8(der, TEAM_ID, KEY_ID).privateKey.export({ format: "jwk" })).toEqual(expected);
  });

  test("rejects keys that are not P-256 EC keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => new ApnsSigningKey(KEY_ID, TEAM_ID, rsa)).toThrow(/elliptic-curve/);

    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey;
    expect(() => new ApnsSigningKey(KEY_ID, TEAM_ID, p384)).toThrow(/P-256/);

    expect(() => ApnsSigningKey.loadFromPkcs8("not a key", TEAM_ID, KEY_ID)).toThrow();
  });
});

describe("AuthenticationToken", () => {
  test("creates an ES256 JWT that APNs accepts", () => {
    const issuedAt = new Date("2026-01-02T03:04:05.678Z");
    const token = AuthenticationToken.create(signingKey, issuedAt);
    const [header, claims, signature] = token.encoded.split(".");

    expect(decodeSegment(header!)).toEqual({ alg: "ES256", typ: "JWT", kid: KEY_ID });
    expect(decodeSegment(claims!)).toEqual({ iss: TEAM_ID, iat: Math.floor(issuedAt.getTime() / 1000) });
    // JWS requires raw (IEEE P1363) r || s signatures: 64 bytes for P-256
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);

    expect(token.authorizationHeader).toBe(`bearer ${token.encoded}`);
    expect(token.issuedAt.getTime()).toBe(Math.floor(issuedAt.getTime() / 1000) * 1000);
    expect(token.verifySignature(verificationKey)).toBe(true);
  });

  test("parses tokens and round-trips their claims", () => {
    const token = AuthenticationToken.create(signingKey);
    const parsed = AuthenticationToken.parse(token.encoded);

    expect(parsed.keyId).toBe(KEY_ID);
    expect(parsed.teamId).toBe(TEAM_ID);
    expect(parsed.issuedAt).toEqual(token.issuedAt);
    expect(parsed.verifySignature(verificationKey)).toBe(true);
    expect(parsed.verifySignature(ApnsVerificationKey.fromSigningKey(signingKey))).toBe(true);
  });

  test("fails verification for the wrong key, team or signature", () => {
    const token = AuthenticationToken.create(signingKey);
    const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;

    expect(token.verifySignature(new ApnsVerificationKey(KEY_ID, TEAM_ID, otherKey))).toBe(false);
    expect(token.verifySignature(new ApnsVerificationKey("OTHERKEY00", TEAM_ID, verificationKey.publicKey))).toBe(false);
    expect(token.verifySignature(new ApnsVerificationKey(KEY_ID, "OTHERTEAM0", verificationKey.publicKey))).toBe(false);

    const [header, claims] = token.encoded.split(".");
    const forged = AuthenticationToken.parse(`${header}.${claims}.${Buffer.alloc(64).toString("base64url")}`);
    expect(forged.verifySignature(verificationKey)).toBe(false);
  });

  test("rejects malformed tokens", () => {
    expect(() => AuthenticationToken.parse("abc")).toThrow();
    expect(() => AuthenticationToken.parse("a.b.c")).toThrow();
    const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: TEAM_ID, iat: 1 })).toString("base64url");
    expect(() => AuthenticationToken.parse(`${header}.${claims}.sig`)).toThrow(/kid/);
  });
});

describe("AuthenticationTokenProvider", () => {
  test("reuses a token until it expires or is invalidated", () => {
    let now = 1_000_000;
    const provider = new AuthenticationTokenProvider(signingKey, 50 * 60_000, () => now);

    const first = provider.getToken();
    now += 49 * 60_000;
    expect(provider.getToken()).toBe(first);

    now += 60_000;
    const second = provider.getToken();
    expect(second).not.toBe(first);

    provider.invalidate(first); // stale token: no effect
    expect(provider.getToken()).toBe(second);

    provider.invalidate(second);
    expect(provider.getToken()).not.toBe(second);
  });
});
