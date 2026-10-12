import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { assertP256, parseEcKey } from "./key-util";

/**
 * A private key used to sign authentication tokens for token-based ("p8") APNs authentication. Keys are issued by
 * Apple and identified by a ten-character key ID; they belong to the team with the given ten-character team ID.
 */
export class ApnsSigningKey {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKey: KeyObject;

  constructor(keyId: string, teamId: string, privateKey: KeyObject) {
    if (keyId == null) throw new TypeError("Key identifier must not be null.");
    if (teamId == null) throw new TypeError("Team identifier must not be null.");
    if (privateKey == null) throw new TypeError("Key must not be null.");
    if (privateKey.type !== "private") throw new TypeError("Signing keys must be private keys.");
    assertP256(privateKey);

    this.keyId = keyId;
    this.teamId = teamId;
    this.privateKey = privateKey;
  }

  /**
   * Loads a signing key from a PKCS#8 file such as the `AuthKey_XXXXXXXXXX.p8` file downloaded from Apple's developer
   * portal.
   */
  static async loadFromPkcs8File(path: string, teamId: string, keyId: string): Promise<ApnsSigningKey> {
    return ApnsSigningKey.loadFromPkcs8(await readFile(path), teamId, keyId);
  }

  /** Synchronous variant of {@link ApnsSigningKey.loadFromPkcs8File}. */
  static loadFromPkcs8FileSync(path: string, teamId: string, keyId: string): ApnsSigningKey {
    return ApnsSigningKey.loadFromPkcs8(readFileSync(path), teamId, keyId);
  }

  /**
   * Loads a signing key from the contents of a `.p8` file. Accepts a PEM string, a PEM string with escaped `\n`
   * newlines (as often found in environment variables), the bare base64 body of the PEM, or DER bytes.
   */
  static loadFromPkcs8(pkcs8: string | Uint8Array, teamId: string, keyId: string): ApnsSigningKey {
    return new ApnsSigningKey(keyId, teamId, parseEcKey(pkcs8, "private"));
  }
}
