import { AuthenticationToken } from "./authentication-token";
import type { ApnsSigningKey } from "./signing-key";

/**
 * Hands out the current authentication token, minting a new one when the current token is older than the configured
 * lifetime or has been rejected by the server as expired.
 *
 * Pushy keeps one token per connection. This port shares a single token across all of a client's connections, which
 * keeps the client well clear of APNs's `TooManyProviderTokenUpdates` limit when it holds several connections.
 */
export class AuthenticationTokenProvider {
  private current: AuthenticationToken | null = null;
  private mintedAt = 0;

  constructor(
    private readonly signingKey: ApnsSigningKey,
    private readonly tokenExpirationMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  getToken(): AuthenticationToken {
    const now = this.now();
    if (this.current === null || now - this.mintedAt >= this.tokenExpirationMs) {
      this.current = AuthenticationToken.create(this.signingKey, new Date(now));
      this.mintedAt = now;
    }
    return this.current;
  }

  /** Discards `token` if it is still the current token, so the next call to `getToken` mints a fresh one. */
  invalidate(token: AuthenticationToken): void {
    if (this.current === token) {
      this.current = null;
    }
  }
}
