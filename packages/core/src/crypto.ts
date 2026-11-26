import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type SecretBag = {
  apiKey?: string;
  webhookSigningKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  baseUrl?: string;
  model?: string;
  accountEmail?: string;
};

export function newUserSalt() {
  return randomBytes(16).toString("base64url");
}

export function deriveUserKey(masterKey: string, userSalt: string) {
  if (!masterKey) throw new Error("ENCRYPTION_KEY fehlt");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(masterKey, "utf8"), Buffer.from(userSalt, "utf8"), "klon-connection", 32),
  );
}

export function encryptJson(key: Buffer, value: SecretBag) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptJson(key: Buffer, payload: string): SecretBag {
  if (!payload) return {};
  const raw = Buffer.from(payload, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  return JSON.parse(text) as SecretBag;
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
