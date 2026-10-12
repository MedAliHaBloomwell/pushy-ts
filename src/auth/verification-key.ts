import { createPublicKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertP256, parseEcKey } from "./key-util";
import type { ApnsSigningKey } from "./signing-key";

/**
 * A public key used to verify authentication tokens. Only servers (such as `MockApnsServer`) need verification keys;
 * clients sign tokens with an {@link ApnsSigningKey}.
 */
export class ApnsVerificationKey {
  readonly keyId: string;
  readonly teamId: string;
  readonly publicKey: KeyObject;

  constructor(keyId: string, teamId: string, publicKey: KeyObject) {
    if (keyId == null) throw new TypeError("Key identifier must not be null.");
    if (teamId == null) throw new TypeError("Team identifier must not be null.");
    if (publicKey == null) throw new TypeError("Key must not be null.");
    if (publicKey.type !== "public") throw new TypeError("Verification keys must be public keys.");
    assertP256(publicKey);

    this.keyId = keyId;
    this.teamId = teamId;
    this.publicKey = publicKey;
  }

  /** Loads a verification key from a PEM-encoded (SPKI) public key file. */
  static async loadFromFile(path: string, teamId: string, keyId: string): Promise<ApnsVerificationKey> {
    return ApnsVerificationKey.load(await readFile(path), teamId, keyId);
  }

  /** Loads a verification key from a PEM string, the bare base64 body of one, or DER bytes. */
  static load(spki: string | Uint8Array, teamId: string, keyId: string): ApnsVerificationKey {
    return new ApnsVerificationKey(keyId, teamId, parseEcKey(spki, "public"));
  }

  /** Derives the verification key that matches a signing key. */
  static fromSigningKey(signingKey: ApnsSigningKey): ApnsVerificationKey {
    return new ApnsVerificationKey(signingKey.keyId, signingKey.teamId, createPublicKey(signingKey.privateKey));
  }
}
