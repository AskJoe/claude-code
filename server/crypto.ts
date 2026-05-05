/**
 * AES-256-GCM helpers for encrypting GitHub access tokens at rest.
 *
 * The encryption key comes from `LAB_TOKEN_ENC_KEY` — 32 bytes hex (64 chars).
 * Generate with: openssl rand -hex 32
 *
 * Format on disk: `<iv_hex>:<ciphertext_hex>:<auth_tag_hex>` (single string).
 * IV is fresh per encryption — never reused.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.LAB_TOKEN_ENC_KEY;
  if (!hex) {
    throw new Error(
      "LAB_TOKEN_ENC_KEY not set. Generate one with: openssl rand -hex 32"
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `LAB_TOKEN_ENC_KEY must be 64 hex chars (32 bytes); got ${hex.length}`
    );
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`;
}

export function decrypt(blob: string): string {
  const [ivHex, ctHex, tagHex] = blob.split(":");
  if (!ivHex || !ctHex || !tagHex) throw new Error("malformed cipher blob");
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  if (tag.length !== TAG_LEN) throw new Error("auth tag wrong size");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
