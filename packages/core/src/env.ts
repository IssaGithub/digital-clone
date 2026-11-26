import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../../../.env"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) config({ path });
  }
  loaded = true;
}

export function appUrl() {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function encryptionKey() {
  return process.env.ENCRYPTION_KEY || "";
}

export function voiceSharedSecret() {
  return process.env.VOICE_SHARED_SECRET || "";
}

export function recallApiBase() {
  return (process.env.RECALL_API_BASE || "https://us-west-2.recall.ai").replace(/\/$/, "");
}

export function voicePublicWsUrl() {
  return process.env.VOICE_PUBLIC_WS_URL || "ws://localhost:3001/recall";
}
