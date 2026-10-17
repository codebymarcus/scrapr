import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

// Parses APP_SECRET_KEY (base64 of exactly 32 bytes). Returns null when unset
// or invalid; never throws.
export function keyFromEnv(env = process.env) {
  const raw = env.APP_SECRET_KEY;
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

// Returns `v1:<ivB64>:<tagB64>:<cipherB64>`.
export function encryptSecret(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

// Throws on wrong key, tampered blob, or malformed input.
export function decryptSecret(blob, key) {
  const parts = String(blob).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("malformed secret blob");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const enc = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("malformed secret blob");
  }
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
