import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type DraftLine,
  type SecretBag,
  IntegrationError,
  appUrl,
  billableLines,
  canFinalize,
  cloneSystemPrompt,
  decryptJson,
  deriveUserKey,
  elevenLabsMp3,
  encryptionKey,
  fallbackReelCopy,
  hasBlockingUnclear,
  heygenCreatePortrait,
  heygenStatus,
  lexwareCreateQuotation,
  lexwareQuotationPdf,
  linesFromModel,
  linesFromTranscript,
  listMcpTools,
  llmComplete,
  type McpEndpoint,
  type McpTool,
  parseReelCopy,
  recallCreateBot,
  refreshGoogleToken,
  refreshMicrosoftToken,
  sendGmailPdf,
  sendOutlookPdf,
  voicePublicWsUrl,
  voiceSharedSecret,
} from "@klon/core";
import { prisma, type ConnectionProvider, type PreferredMail } from "@klon/db";

export function storageRoot() {
  return resolve(process.cwd(), process.cwd().endsWith("klon-plattform") ? "storage" : "../../storage");
}

export async function userKey(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { user, key: deriveUserKey(encryptionKey(), user.encryptionSalt) };
}

export async function readSecrets(userId: string, provider: ConnectionProvider): Promise<SecretBag | null> {
  if (!encryptionKey()) return null;
  const connection = await prisma.connection.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!connection?.connected || !connection.encryptedPayload) return null;
  const { key } = await userKey(userId);
  return decryptJson(key, connection.encryptedPayload);
}

export async function enqueue(type: "start_bot" | "draft_offer" | "render_reel", payload: object, runAt = new Date()) {
  return prisma.queueJob.create({
    data: { type, payload, runAt, status: "pending" },
  });
}

async function freshMailToken(userId: string, provider: "google" | "microsoft", secret: SecretBag) {
  const expires = secret.expiresAt ? new Date(secret.expiresAt).getTime() : 0;
  if (secret.accessToken && expires > Date.now() + 60_000) return secret.accessToken;
  if (!secret.refreshToken) return secret.accessToken || "";
  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    if (!clientId || !clientSecret) return secret.accessToken || "";
    const next = await refreshGoogleToken({ refreshToken: secret.refreshToken, clientId, clientSecret });
    await storeRefreshed(userId, provider, secret, next.access_token, next.expires_in, secret.refreshToken);
    return next.access_token;
  }
  const clientId = process.env.MICROSOFT_CLIENT_ID || "";
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return secret.accessToken || "";
  const next = await refreshMicrosoftToken({ refreshToken: secret.refreshToken, clientId, clientSecret });
  await storeRefreshed(userId, provider, secret, next.access_token, next.expires_in, next.refresh_token || secret.refreshToken);
  return next.access_token;
}

async function storeRefreshed(
  userId: string,
  provider: "google" | "microsoft",
  previous: SecretBag,
  accessToken: string,
  expiresIn: number,
  refreshToken: string,
) {
  const { encryptJson } = await import("@klon/core");
  const { key } = await userKey(userId);
  const bag: SecretBag = {
    ...previous,
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  await prisma.connection.update({
    where: { userId_provider: { userId, provider } },
    data: { encryptedPayload: encryptJson(key, bag), connected: true },
  });
}

export async function runStartBot(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { clone: true, callSession: true },
  });
  if (!booking) return;
  if (booking.callSession?.recallBotId) return;
  if (!booking.joinUrl || booking.locationType === "unknown") {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: "failed" },
    });
    await prisma.callSession.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        status: "failed",
        lastError: "Kein Google-Meet- oder Teams-Link in scheduled_event.location.",
      },
      update: {
        status: "failed",
        lastError: "Kein Google-Meet- oder Teams-Link in scheduled_event.location.",
      },
    });
    return;
  }
  const recall = await readSecrets(booking.clone.userId, "recall");
  if (!recall?.apiKey) {
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "failed" } });
    await prisma.callSession.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        status: "failed",
        lastError: "Recall.ai ist nicht angeschlossen.",
      },
      update: { status: "failed", lastError: "Recall.ai ist nicht angeschlossen." },
    });
    return;
  }
  const secret = voiceSharedSecret();
  const baseWs = voicePublicWsUrl();
  const websocketUrl =
    secret && !baseWs.includes("secret=")
      ? `${baseWs}${baseWs.includes("?") ? "&" : "?"}secret=${encodeURIComponent(secret)}`
      : baseWs;
  const botId = await recallCreateBot(recall.apiKey, {
    meetingUrl: booking.joinUrl,
    joinAt: booking.startsAt.toISOString(),
    botName: `${booking.clone.name} (Klon)`,
    websocketUrl,
    bookingId: booking.id,
  });
  await prisma.callSession.upsert({
    where: { bookingId: booking.id },
    create: { bookingId: booking.id, recallBotId: botId, status: "scheduled" },
    update: { recallBotId: botId, status: "scheduled", lastError: "" },
  });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "bot_queued" } });
}

export async function runDraftOffer(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      clone: { include: { priceItems: true } },
      callSession: true,
      offer: true,
    },
  });
  if (!booking || booking.offer) return;
  const transcript = booking.callSession?.transcript || "";
  const catalog = booking.clone.priceItems.filter((item) => item.active);
  let lines: DraftLine[] = linesFromTranscript(transcript, catalog);
  const llm = await readSecrets(booking.clone.userId, "llm");
  if (llm?.apiKey && transcript.trim()) {
    try {
      const raw = await llmComplete(
        llm,
        "Antworte nur mit JSON: {\"customerName\":string,\"lines\":[{\"label\":string,\"quantity\":number,\"priceItemId\":string|null}]}. Preise nicht erfinden. priceItemId nur aus der Liste, sonst null.",
        `${cloneSystemPrompt({ name: booking.clone.name, knowledge: booking.clone.knowledge, items: catalog })}\n\nTranskript:\n${transcript}`,
      );
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as {
          lines?: { label?: string; quantity?: number; priceItemId?: string | null }[];
        };
        lines = linesFromModel(parsed.lines || [], catalog, transcript);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraktion fehlgeschlagen";
      lines = linesFromTranscript(transcript, catalog);
      await prisma.callSession.update({
        where: { bookingId: booking.id },
        data: { lastError: message },
      });
    }
  }
  const blocked = hasBlockingUnclear(lines);
  const offer = await prisma.offer.create({
    data: {
      cloneId: booking.cloneId,
      bookingId: booking.id,
      status: "draft",
      customerName: booking.inviteeName,
      customerEmail: booking.inviteeEmail,
      lines,
      blockedReason: blocked ? "Unklare Posten bleiben Entwurf und werden nicht finalisiert." : "",
    },
  });
  const lexware = await readSecrets(booking.clone.userId, "lexware");
  if (lexware?.apiKey && billableLines(lines).length) {
    try {
      const quotationId = await lexwareCreateQuotation(lexware.apiKey, {
        customerName: booking.inviteeName,
        lines,
        voucherDate: new Date().toISOString().slice(0, 10),
        finalize: false,
      });
      await prisma.offer.update({
        where: { id: offer.id },
        data: { lexwareQuotationId: quotationId, lastError: "" },
      });
    } catch (error) {
      await prisma.offer.update({
        where: { id: offer.id },
        data: { lastError: error instanceof Error ? error.message : "Lexware-Entwurf fehlgeschlagen" },
      });
    }
  } else if (!lexware?.apiKey) {
    await prisma.offer.update({
      where: { id: offer.id },
      data: { lastError: "Lexware ist nicht angeschlossen. Der Entwurf liegt nur in der App." },
    });
  }
  if (booking.clone.autoSendOffers && canFinalize(lines)) {
    await approveAndSend(offer.id);
  }
}

export async function approveAndSend(offerId: string) {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: { clone: true, booking: true },
  });
  if (!offer) throw new IntegrationError("Angebot fehlt");
  const lines = offer.lines as DraftLine[];
  if (!canFinalize(lines)) {
    throw new IntegrationError("Unklare Posten blockieren die Freigabe. Es wird nichts finalisiert.");
  }
  const lexware = await readSecrets(offer.clone.userId, "lexware");
  if (!lexware?.apiKey) throw new IntegrationError("Lexware ist nicht angeschlossen.");
  const finalId = await lexwareCreateQuotation(lexware.apiKey, {
    customerName: offer.customerName,
    lines,
    voucherDate: new Date().toISOString().slice(0, 10),
    finalize: true,
  });
  const pdf = await lexwareQuotationPdf(lexware.apiKey, finalId);
  const dir = resolve(storageRoot(), "offers");
  await mkdir(dir, { recursive: true });
  const pdfPath = resolve(dir, `${offer.id}.pdf`);
  await writeFile(pdfPath, pdf);
  await prisma.offer.update({
    where: { id: offer.id },
    data: {
      status: "finalized",
      lexwareFinalId: finalId,
      pdfPath,
      finalizedAt: new Date(),
      blockedReason: "",
      lastError: "",
    },
  });
  await deliverPdf(offer.id, pdf);
}

async function deliverPdf(offerId: string, pdf: Buffer) {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: { clone: true },
  });
  if (!offer) return;
  const channel = await pickChannel(offer.clone.userId, offer.clone.preferredMail);
  if (!channel) {
    await prisma.offer.update({
      where: { id: offer.id },
      data: { lastError: "Weder Gmail noch Outlook ist angeschlossen. PDF liegt bereit." },
    });
    return;
  }
  const secret = await readSecrets(offer.clone.userId, channel);
  const token = secret ? await freshMailToken(offer.clone.userId, channel, secret) : "";
  if (!token) {
    await prisma.offer.update({
      where: { id: offer.id },
      data: { lastError: `${channel} ist nicht angeschlossen.` },
    });
    return;
  }
  const text = `Guten Tag ${offer.customerName},\nim Anhang ist das freigegebene Angebot.\n`;
  if (channel === "google") {
    await sendGmailPdf(token, { to: offer.customerEmail, subject: "Angebot", text, pdf });
  } else {
    await sendOutlookPdf(token, { to: offer.customerEmail, subject: "Angebot", text, pdf });
  }
  await prisma.offer.update({
    where: { id: offer.id },
    data: {
      status: "sent",
      mailChannel: channel === "google" ? "gmail" : "outlook",
      sentTo: offer.customerEmail,
      sentAt: new Date(),
      lastError: "",
    },
  });
}

async function pickChannel(userId: string, preferred: PreferredMail): Promise<"google" | "microsoft" | null> {
  const google = await readSecrets(userId, "google");
  const microsoft = await readSecrets(userId, "microsoft");
  if (preferred === "gmail") return google?.accessToken ? "google" : null;
  if (preferred === "outlook") return microsoft?.accessToken ? "microsoft" : null;
  if (google?.accessToken) return "google";
  if (microsoft?.accessToken) return "microsoft";
  return null;
}

export async function retrySend(offerId: string) {
  const offer = await prisma.offer.findUnique({ where: { id: offerId } });
  if (!offer?.pdfPath) throw new IntegrationError("PDF fehlt noch.");
  const { readFile } = await import("node:fs/promises");
  const pdf = await readFile(offer.pdfPath);
  await deliverPdf(offerId, pdf);
}

export async function runRenderReel(reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, include: { clone: true } });
  if (!reel || reel.status === "ready") return;
  await prisma.reel.update({ where: { id: reel.id }, data: { status: "scripting", lastError: "" } });
  let copy = fallbackReelCopy(reel.briefing, reel.clone.name);
  const llm = await readSecrets(reel.clone.userId, "llm");
  if (llm?.apiKey) {
    try {
      const raw = await llmComplete(
        llm,
        "Schreibe ein kurzes vertikales Skript auf Deutsch. Antworte nur mit JSON {\"script\":string,\"voiceText\":string}. voiceText ist der gesprochene ElevenLabs-Text, ohne Regieanweisungen.",
        `Klon: ${reel.clone.name}\nWissen:\n${reel.clone.knowledge}\nBriefing:\n${reel.briefing}`,
      );
      copy = parseReelCopy(raw, reel.briefing, reel.clone.name);
    } catch (error) {
      copy = fallbackReelCopy(reel.briefing, reel.clone.name);
      await prisma.reel.update({
        where: { id: reel.id },
        data: { lastError: error instanceof Error ? error.message : "Skript ohne Sprachmodell" },
      });
    }
  }
  await prisma.reel.update({
    where: { id: reel.id },
    data: { script: copy.script, voiceText: copy.voiceText },
  });

  const eleven = await readSecrets(reel.clone.userId, "elevenlabs");
  if (eleven?.apiKey && reel.clone.voiceId) {
    try {
      const audio = await elevenLabsMp3(eleven.apiKey, reel.clone.voiceId, copy.voiceText);
      const dir = resolve(storageRoot(), "reels");
      await mkdir(dir, { recursive: true });
      const voiceAudioPath = resolve(dir, `${reel.id}.mp3`);
      await writeFile(voiceAudioPath, audio);
      await prisma.reel.update({ where: { id: reel.id }, data: { voiceAudioPath } });
    } catch (error) {
      await prisma.reel.update({
        where: { id: reel.id },
        data: { lastError: error instanceof Error ? error.message : "ElevenLabs fehlgeschlagen" },
      });
    }
  }

  const heygen = await readSecrets(reel.clone.userId, "heygen");
  if (!heygen?.apiKey) {
    await prisma.reel.update({
      where: { id: reel.id },
      data: {
        status: "failed",
        lastError: "HeyGen ist nicht angeschlossen. Skript und Sprechertext liegen vor, es gibt kein Video.",
      },
    });
    return;
  }
  const videoId = await heygenCreatePortrait(heygen.apiKey, {
    avatarId: reel.clone.heygenAvatarId,
    voiceId: reel.clone.heygenVoiceId,
    text: copy.voiceText,
  });
  await prisma.reel.update({
    where: { id: reel.id },
    data: { heygenVideoId: videoId, status: "rendering" },
  });
  await enqueue("render_reel", { reelId: reel.id, phase: "poll", pollCount: 1 }, new Date(Date.now() + 15_000));
}

export async function pollReel(reelId: string, pollCount = 0) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, include: { clone: true } });
  if (!reel?.heygenVideoId) return;
  if (pollCount > 40) {
    await prisma.reel.update({
      where: { id: reel.id },
      data: { status: "failed", lastError: "HeyGen-Render hat zu lange gedauert." },
    });
    return;
  }
  const heygen = await readSecrets(reel.clone.userId, "heygen");
  if (!heygen?.apiKey) {
    await prisma.reel.update({
      where: { id: reel.id },
      data: { status: "failed", lastError: "HeyGen ist nicht angeschlossen." },
    });
    return;
  }
  const status = await heygenStatus(heygen.apiKey, reel.heygenVideoId);
  if (status.status === "completed" && status.videoUrl) {
    const response = await fetch(status.videoUrl);
    if (!response.ok) throw new IntegrationError("HeyGen-Download fehlgeschlagen", response.status);
    const dir = resolve(storageRoot(), "reels");
    await mkdir(dir, { recursive: true });
    const videoPath = resolve(dir, `${reel.id}.mp4`);
    await writeFile(videoPath, Buffer.from(await response.arrayBuffer()));
    await prisma.reel.update({
      where: { id: reel.id },
      data: { status: "ready", videoPath, lastError: "" },
    });
    return;
  }
  if (status.status === "failed") {
    await prisma.reel.update({
      where: { id: reel.id },
      data: { status: "failed", lastError: status.error || "HeyGen-Render fehlgeschlagen" },
    });
    return;
  }
  await enqueue("render_reel", { reelId: reel.id, phase: "poll", pollCount: pollCount + 1 }, new Date(Date.now() + 15_000));
}

export async function processNextJob() {
  const candidate = await prisma.queueJob.findFirst({
    where: { status: "pending", runAt: { lte: new Date() } },
    orderBy: { runAt: "asc" },
  });
  if (!candidate) return false;
  const claimed = await prisma.queueJob.updateMany({
    where: { id: candidate.id, status: "pending" },
    data: { status: "running", lockedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return false;
  const job = await prisma.queueJob.findUniqueOrThrow({ where: { id: candidate.id } });
  try {
    const payload = job.payload as { bookingId?: string; reelId?: string; phase?: string; pollCount?: number };
    if (job.type === "start_bot" && payload.bookingId) await runStartBot(payload.bookingId);
    if (job.type === "draft_offer" && payload.bookingId) await runDraftOffer(payload.bookingId);
    if (job.type === "render_reel" && payload.reelId) {
      if (payload.phase === "poll") await pollReel(payload.reelId, payload.pollCount ?? 0);
      else await runRenderReel(payload.reelId);
    }
    await prisma.queueJob.update({ where: { id: job.id }, data: { status: "done", lastError: "" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job fehlgeschlagen";
    const failed = job.attempts >= 5;
    await prisma.queueJob.update({
      where: { id: job.id },
      data: failed
        ? { status: "failed", lastError: message }
        : { status: "pending", lastError: message, runAt: new Date(Date.now() + 20_000) },
    });
    if (job.type === "render_reel") {
      const payload = job.payload as { reelId?: string };
      if (payload.reelId && failed) {
        await prisma.reel.update({
          where: { id: payload.reelId },
          data: { status: "failed", lastError: message },
        });
      }
    }
  }
  return true;
}

export async function loadCloneMcp(cloneId: string): Promise<{
  tools: McpTool[];
  endpoints: Map<string, McpEndpoint>;
}> {
  const clone = await prisma.clone.findUnique({
    where: { id: cloneId },
    include: { mcpServers: true },
  });
  const tools: McpTool[] = [];
  const endpoints = new Map<string, McpEndpoint>();
  if (!clone) return { tools, endpoints };
  const key = encryptionKey() ? (await userKey(clone.userId)).key : null;
  for (const server of clone.mcpServers) {
    const headers =
      key && server.encryptedHeaders ? decryptJson(key, server.encryptedHeaders).headers || {} : {};
    const endpoint = { name: server.name, url: server.url, headers };
    endpoints.set(server.name, endpoint);
    try {
      const listed = await listMcpTools(endpoint);
      tools.push(...listed);
      await prisma.mcpServer.update({
        where: { id: server.id },
        data: { reachable: true, lastError: "", toolNames: listed.map((tool) => tool.name).join(", ") },
      });
    } catch (error) {
      await prisma.mcpServer.update({
        where: { id: server.id },
        data: {
          reachable: false,
          toolNames: "",
          lastError: error instanceof Error ? error.message : "MCP-Server nicht erreichbar",
        },
      });
    }
  }
  return { tools, endpoints };
}

export function webhookUrl(userId: string) {
  return `${appUrl()}/api/webhooks/calendly/${userId}`;
}

export function missingPlatformEnv(names: readonly string[]) {
  return names.filter((name) => !process.env[name]);
}
