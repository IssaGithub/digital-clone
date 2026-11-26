import { NextResponse } from "next/server";
import { appUrl, googleAuthUrl, loadEnv, microsoftAuthUrl } from "@klon/core";
import { currentUser } from "@/lib/session";
import { createHmac } from "node:crypto";

loadEnv();

function stateFor(userId: string, provider: string) {
  const body = Buffer.from(JSON.stringify({ userId, provider, exp: Date.now() + 10 * 60 * 1000 })).toString("base64url");
  const mac = createHmac("sha256", process.env.SESSION_SECRET || "").update(body).digest("base64url");
  return `${body}.${mac}`;
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", appUrl()));
  const redirectUri = `${appUrl()}/api/oauth/${provider}/callback`;
  const state = stateFor(user.id, provider);
  if (provider === "google") {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return NextResponse.redirect(new URL("/app/verbindungen?hinweis=Google-OAuth+ist+nicht+konfiguriert", appUrl()));
    }
    return NextResponse.redirect(googleAuthUrl({ clientId: process.env.GOOGLE_CLIENT_ID, redirectUri, state }));
  }
  if (provider === "microsoft") {
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
      return NextResponse.redirect(new URL("/app/verbindungen?hinweis=Microsoft-OAuth+ist+nicht+konfiguriert", appUrl()));
    }
    return NextResponse.redirect(microsoftAuthUrl({ clientId: process.env.MICROSOFT_CLIENT_ID, redirectUri, state }));
  }
  return NextResponse.redirect(new URL("/app/verbindungen", request.url));
}
