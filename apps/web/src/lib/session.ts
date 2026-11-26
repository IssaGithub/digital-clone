import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { loadEnv } from "@klon/core";
import { prisma } from "@klon/db";

loadEnv();

type Payload = { uid: string; exp: number };

function secret() {
  return process.env.SESSION_SECRET || "";
}

function sign(body: string) {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function sessionReady() {
  return Boolean(secret() && process.env.ENCRYPTION_KEY);
}

export async function currentUser() {
  if (!sessionReady()) return null;
  const jar = await cookies();
  const raw = jar.get("klon_session")?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(body);
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  if (payload.exp < Date.now()) return null;
  return prisma.user.findUnique({ where: { id: payload.uid } });
}

export async function setSession(userId: string) {
  if (!secret()) throw new Error("SESSION_SECRET fehlt");
  const payload: Payload = { uid: userId, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const jar = await cookies();
  jar.set("klon_session", `${body}.${sign(body)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.APP_URL?.startsWith("https://") ?? false,
  });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete("klon_session");
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new Error("Nicht angemeldet");
  return user;
}
