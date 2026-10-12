import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

type KeyKind = "private" | "public";

const PEM_LABELS: Record<KeyKind, string> = { private: "PRIVATE KEY", public: "PUBLIC KEY" };

/**
 * Parses an EC key from the shapes people actually store APNs keys in: a PEM file (`AuthKey_XXXXXXXXXX.p8`), a PEM
 * string whose newlines were escaped as `\n` (common in environment variables), the bare base64 body of the PEM, or
 * DER bytes.
 */
export function parseEcKey(input: string | Uint8Array, kind: KeyKind): KeyObject {
  const create = kind === "private" ? createPrivateKey : createPublicKey;
  let key: KeyObject;

  if (typeof input !== "string" && input[0] === 0x30) {
    // ASN.1 SEQUENCE: DER-encoded PKCS#8 / SPKI
    const der = Buffer.from(input);
    key =
      kind === "private"
        ? createPrivateKey({ key: der, format: "der", type: "pkcs8" })
        : createPublicKey({ key: der, format: "der", type: "spki" });
  } else {
    let text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
    text = text.replace(/\\n/g, "\n").trim();

    if (!text.includes("-----BEGIN")) {
      const body = text.replace(/\s+/g, "");
      const lines = body.match(/.{1,64}/g) ?? [];
      text = `-----BEGIN ${PEM_LABELS[kind]}-----\n${lines.join("\n")}\n-----END ${PEM_LABELS[kind]}-----\n`;
    }

    key = create({ key: text, format: "pem" });
  }

  assertP256(key);
  return key;
}

export function assertP256(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ec") {
    throw new TypeError(`APNs keys must be elliptic-curve keys, but got a ${key.asymmetricKeyType ?? key.type} key.`);
  }

  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== undefined && curve !== "prime256v1" && curve !== "P-256") {
    throw new TypeError(`APNs keys must use the P-256 curve, but got ${curve}.`);
  }
}
