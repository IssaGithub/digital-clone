import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appUrl,
  encryptJson,
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  googleEmail,
  loadEnv,
  microsoftEmail,
  type SecretBag,
} from "@klon/core";
import { prisma } from "@klon/db";
import { userKey } from "@klon/domain";

loadEnv();

function readState(state: string, provider: string) {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = createHmac("sha256", process.env.SESSION_SECRET || "").update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    userId: string;
    provider: string;
    exp: number;
  };
  if (payload.provider !== provider || payload.exp < Date.now()) return null;
  return payload;
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const state = readState(url.searchParams.get("state") || "", provider);
  if (!state || !code) {
    return NextResponse.redirect(new URL("/app/verbindungen?hinweis=OAuth+abgebrochen", appUrl()));
  }
  const redirectUri = `${appUrl()}/api/oauth/${provider}/callback`;
  let bag: SecretBag = {};
  let label = "";
  if (provider === "google") {
    const token = await exchangeGoogleCode({
      code,
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirectUri,
    });
    label = await googleEmail(token.access_token);
    bag = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      accountEmail: label,
    };
  } else if (provider === "microsoft") {
    const token = await exchangeMicrosoftCode({
      code,
      clientId: process.env.MICROSOFT_CLIENT_ID || "",
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || "",
      redirectUri,
    });
    label = await microsoftEmail(token.access_token);
    bag = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      accountEmail: label,
    };
  } else {
    return NextResponse.redirect(new URL("/app/verbindungen", appUrl()));
  }
  const { key } = await userKey(state.userId);
  const dbProvider = provider === "google" ? "google" : "microsoft";
  await prisma.connection.upsert({
    where: { userId_provider: { userId: state.userId, provider: dbProvider } },
    create: {
      userId: state.userId,
      provider: dbProvider,
      connected: true,
      encryptedPayload: encryptJson(key, bag),
      accountLabel: label,
    },
    update: {
      connected: true,
      encryptedPayload: encryptJson(key, bag),
      accountLabel: label,
    },
  });
  return NextResponse.redirect(new URL("/app/verbindungen", appUrl()));
}
