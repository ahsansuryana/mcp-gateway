// ADR 0013: the inbound bearer key generated when the gateway creates its own config.
//
// One function so that "where does this key come from" has exactly one answer in the
// repository, and so the strength is stated in one place rather than chosen at each call
// site.

import { randomBytes } from 'node:crypto';

/**
 * Bytes of entropy per key. 32 bytes = 256 bits, which is the size AES-256 uses and far
 * more than a brute-force attacker has any use for against a key that is compared with
 * timingSafeEqual. It renders to 43 characters in base64url.
 */
export const API_KEY_BYTES = 32;

/**
 * Returns a fresh inbound bearer key.
 *
 * base64url, deliberately: the value has to survive being pasted into a curl `-H` header, a
 * JSON config, a `.env` file and a shell variable, and standard base64's `+`, `/` and `=`
 * each need escaping in at least one of those. The alphabet is the reason this is not
 * `toString('base64')`.
 *
 * The key is returned to the caller and nowhere else. It is never logged, never added to
 * /status, and never included in an error message (PLAN.md rule 9). The only place it is
 * written is the config file `mcp-gate init` or the auto-create path creates, with mode
 * 0600 inside a 0700 directory.
 */
export function generateApiKey(bytes: number = API_KEY_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}