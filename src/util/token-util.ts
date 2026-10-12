/**
 * Strips everything but hex digits from a device token string, e.g. turning `<1234 5678 ...>` (the description of an
 * `NSData` token) into `12345678...`.
 */
export function sanitizeTokenString(tokenString: string): string {
  return tokenString.replace(/[^a-fA-F0-9]/g, "");
}

/** Pushy-compatible namespace for {@link sanitizeTokenString}. */
export const TokenUtil = { sanitizeTokenString } as const;
