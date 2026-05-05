/**
 * Password hashing using Node's built-in scrypt — no extra deps, no native
 * compile, OWASP-recommended for password storage.
 *
 * Format on disk: `scrypt$N$r$p$<salt-hex>$<hash-hex>` so we can rotate
 * parameters later without losing existing accounts.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  pwd: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number }
) => Promise<Buffer>;

// Parameters tuned for ~150ms per hash on a modern dev box. Bump N if hardware
// gets faster.
const PARAMS = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) throw new Error("password must be at least 8 chars");
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(plain, salt, HASH_BYTES, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("hex")}$${hash.toString(
    "hex"
  )}`;
}

export async function verifyPassword(
  plain: string,
  stored: string
): Promise<boolean> {
  const [scheme, nStr, rStr, pStr, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(plain, salt, expected.length, { N, r, p });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
