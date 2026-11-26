"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  CONNECTION_PROVIDERS,
  DEFAULT_DISCLOSURE,
  type DraftLine,
  type ProviderId,
  type SecretBag,
  encryptJson,
  newUserSalt,
  providerMeta,
} from "@klon/core";
import { prisma, type PlannedActionType } from "@klon/db";
import { approveAndSend, enqueue, retrySend, userKey } from "@klon/domain";
import { clearSession, requireUser, setSession } from "./session";

function text(form: FormData, key: string) {
  return String(form.get(key) || "").trim();
}

export async function login(form: FormData) {
  const email = text(form, "email").toLowerCase();
  const name = text(form, "name");
  const password = text(form, "password");
  const expected = process.env.DASHBOARD_PASSWORD || "";
  if (!email || !name) return;
  if (expected && password !== expected) redirect("/login?fehler=passwort");
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name, encryptionSalt: newUserSalt() },
    });
  }
  await setSession(user.id);
  redirect("/app");
}

export async function logout() {
  await clearSession();
  redirect("/");
}

export async function createClone(form: FormData) {
  const user = await requireUser();
  const name = text(form, "name");
  if (!name) return;
  const clone = await prisma.clone.create({
    data: {
      userId: user.id,
      name,
      voiceId: text(form, "voiceId"),
      heygenAvatarId: text(form, "heygenAvatarId"),
      heygenVoiceId: text(form, "heygenVoiceId"),
      knowledge: text(form, "knowledge"),
      disclosureText: text(form, "disclosureText") || DEFAULT_DISCLOSURE,
      autoSendOffers: form.get("autoSendOffers") === "on",
      preferredMail: (text(form, "preferredMail") || "auto") as "auto" | "gmail" | "outlook",
      calendlyEventTypeUri: text(form, "calendlyEventTypeUri"),
      plannedActions: {
        create: [
          { type: "quotation" satisfies PlannedActionType, enabled: true, note: "Angebot nach dem Call." },
          { type: "reel" satisfies PlannedActionType, enabled: true, note: "Vertikales Video in der App." },
          {
            type: "github_project" satisfies PlannedActionType,
            enabled: false,
            note: "Vorbereitet im Datenmodell. Wird nicht ausgeführt.",
          },
        ],
      },
    },
  });
  redirect(`/app/clones/${clone.id}`);
}

export async function updateClone(form: FormData) {
  const user = await requireUser();
  const id = text(form, "id");
  const clone = await prisma.clone.findFirst({ where: { id, userId: user.id } });
  if (!clone) return;
  await prisma.clone.update({
    where: { id },
    data: {
      name: text(form, "name") || clone.name,
      voiceId: text(form, "voiceId"),
      heygenAvatarId: text(form, "heygenAvatarId"),
      heygenVoiceId: text(form, "heygenVoiceId"),
      knowledge: text(form, "knowledge"),
      disclosureText: text(form, "disclosureText") || DEFAULT_DISCLOSURE,
      autoSendOffers: form.get("autoSendOffers") === "on",
      preferredMail: (text(form, "preferredMail") || "auto") as "auto" | "gmail" | "outlook",
      calendlyEventTypeUri: text(form, "calendlyEventTypeUri"),
    },
  });
  revalidatePath(`/app/clones/${id}`);
}

export async function addPrice(form: FormData) {
  const user = await requireUser();
  const cloneId = text(form, "cloneId");
  const clone = await prisma.clone.findFirst({ where: { id: cloneId, userId: user.id } });
  if (!clone) return;
  const euros = Number(text(form, "euros").replace(",", "."));
  if (!text(form, "name") || !Number.isFinite(euros)) return;
  await prisma.priceItem.create({
    data: {
      cloneId,
      name: text(form, "name"),
      description: text(form, "description"),
      unit: text(form, "unit") || "Stück",
      unitPriceCents: Math.round(euros * 100),
      taxPercent: Number(text(form, "taxPercent") || 19),
      currency: "EUR",
    },
  });
  revalidatePath(`/app/clones/${cloneId}`);
}

export async function deactivatePrice(form: FormData) {
  const user = await requireUser();
  const id = text(form, "id");
  const item = await prisma.priceItem.findFirst({ where: { id, clone: { userId: user.id } } });
  if (!item) return;
  await prisma.priceItem.update({ where: { id }, data: { active: false } });
  revalidatePath(`/app/clones/${item.cloneId}`);
}

export async function saveConnection(form: FormData) {
  const user = await requireUser();
  const provider = text(form, "provider") as ProviderId;
  const meta = providerMeta(provider);
  if (!meta || meta.mode !== "keys") return;
  if (!process.env.ENCRYPTION_KEY) redirect("/app/verbindungen?fehler=schluessel");
  const bag: SecretBag = {};
  for (const field of meta.fields) {
    const value = text(form, field.key);
    if (value) (bag as Record<string, string>)[field.key] = value;
  }
  if (!bag.apiKey) {
    await prisma.connection.upsert({
      where: { userId_provider: { userId: user.id, provider } },
      create: { userId: user.id, provider, connected: false, encryptedPayload: "", accountLabel: "" },
      update: { connected: false, encryptedPayload: "", accountLabel: "" },
    });
    revalidatePath("/app/verbindungen");
    return;
  }
  const { key } = await userKey(user.id);
  await prisma.connection.upsert({
    where: { userId_provider: { userId: user.id, provider } },
    create: {
      userId: user.id,
      provider,
      connected: true,
      encryptedPayload: encryptJson(key, bag),
      accountLabel: provider === "llm" ? bag.model || "Sprachmodell" : "Schlüssel hinterlegt",
    },
    update: {
      connected: true,
      encryptedPayload: encryptJson(key, bag),
      accountLabel: provider === "llm" ? bag.model || "Sprachmodell" : "Schlüssel hinterlegt",
    },
  });
  revalidatePath("/app/verbindungen");
}

export async function disconnect(form: FormData) {
  const user = await requireUser();
  const provider = text(form, "provider") as ProviderId;
  if (!CONNECTION_PROVIDERS.some((item) => item.id === provider)) return;
  await prisma.connection.upsert({
    where: { userId_provider: { userId: user.id, provider } },
    create: { userId: user.id, provider, connected: false, encryptedPayload: "" },
    update: { connected: false, encryptedPayload: "", accountLabel: "" },
  });
  revalidatePath("/app/verbindungen");
}

export async function createTestBooking(form: FormData) {
  const user = await requireUser();
  const cloneId = text(form, "cloneId");
  const clone = await prisma.clone.findFirst({ where: { id: cloneId, userId: user.id } });
  if (!clone) return;
  const locationType = text(form, "locationType");
  const booking = await prisma.booking.create({
    data: {
      cloneId,
      inviteeName: text(form, "inviteeName") || "Testkunde",
      inviteeEmail: text(form, "inviteeEmail") || user.email,
      startsAt: new Date(text(form, "startsAt") || Date.now() + 10 * 60 * 1000),
      joinUrl: text(form, "joinUrl"),
      locationType:
        locationType === "google_conference" || locationType === "microsoft_teams" ? locationType : "unknown",
      status: "scheduled",
      calendlyUri: "",
    },
  });
  await enqueue("start_bot", { bookingId: booking.id });
  redirect(`/app/buchungen/${booking.id}`);
}

export async function simulateCall(form: FormData) {
  const user = await requireUser();
  const bookingId = text(form, "bookingId");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, clone: { userId: user.id } },
    include: { clone: true },
  });
  if (!booking) return;
  const transcript = text(form, "transcript");
  await prisma.callSession.upsert({
    where: { bookingId },
    create: {
      bookingId,
      status: "ended",
      transcript: `Klon: ${booking.clone.disclosureText}\n${transcript}`,
      disclosurePlayed: true,
      endedAt: new Date(),
      startedAt: new Date(),
    },
    update: {
      status: "ended",
      transcript: `Klon: ${booking.clone.disclosureText}\n${transcript}`,
      disclosurePlayed: true,
      endedAt: new Date(),
    },
  });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: "ended" } });
  const existing = await prisma.offer.findUnique({ where: { bookingId } });
  if (!existing) await enqueue("draft_offer", { bookingId });
  revalidatePath(`/app/buchungen/${bookingId}`);
}

export async function dropUnclear(form: FormData) {
  const user = await requireUser();
  const offer = await prisma.offer.findFirst({
    where: { id: text(form, "offerId"), clone: { userId: user.id } },
  });
  if (!offer || offer.status !== "draft") return;
  const lineId = text(form, "lineId");
  const lines = (offer.lines as DraftLine[]).map((line) => (line.id === lineId ? { ...line, dropped: true } : line));
  const blocked = lines.some((line) => line.unclear && !line.dropped);
  await prisma.offer.update({
    where: { id: offer.id },
    data: {
      lines,
      blockedReason: blocked ? "Unklare Posten bleiben Entwurf und werden nicht finalisiert." : "",
    },
  });
  revalidatePath(`/app/angebote/${offer.id}`);
}

export async function releaseOffer(form: FormData) {
  const user = await requireUser();
  const offer = await prisma.offer.findFirst({
    where: { id: text(form, "offerId"), clone: { userId: user.id } },
  });
  if (!offer) return;
  try {
    await approveAndSend(offer.id);
  } catch (error) {
    await prisma.offer.update({
      where: { id: offer.id },
      data: { lastError: error instanceof Error ? error.message : "Freigabe fehlgeschlagen", status: "draft" },
    });
  }
  revalidatePath(`/app/angebote/${offer.id}`);
}

export async function sendAgain(form: FormData) {
  const user = await requireUser();
  const offer = await prisma.offer.findFirst({
    where: { id: text(form, "offerId"), clone: { userId: user.id } },
  });
  if (!offer) return;
  try {
    await retrySend(offer.id);
  } catch (error) {
    await prisma.offer.update({
      where: { id: offer.id },
      data: { lastError: error instanceof Error ? error.message : "Versand fehlgeschlagen" },
    });
  }
  revalidatePath(`/app/angebote/${offer.id}`);
}

export async function createReel(form: FormData) {
  const user = await requireUser();
  const cloneId = text(form, "cloneId");
  const clone = await prisma.clone.findFirst({ where: { id: cloneId, userId: user.id } });
  const briefing = text(form, "briefing");
  if (!clone || !briefing) return;
  const reel = await prisma.reel.create({
    data: { cloneId, briefing, status: "queued" },
  });
  await enqueue("render_reel", { reelId: reel.id });
  redirect(`/app/reels/${reel.id}`);
}
