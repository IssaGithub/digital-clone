import { createHmac, timingSafeEqual } from "node:crypto";

export type MeetingLocationType = "google_conference" | "microsoft_teams" | "unknown";

export type ParsedInvitee = {
  eventName: string;
  calendlyUri: string;
  eventTypeUri: string;
  inviteeName: string;
  inviteeEmail: string;
  startsAt: string;
  joinUrl: string;
  locationType: MeetingLocationType;
};

const TOLERANCE_MS = 3 * 60 * 1000;

export function verifyCalendlySignature(
  rawBody: string,
  header: string | null,
  signingKey: string,
  now = Date.now(),
) {
  if (!header || !signingKey) return false;
  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const index = piece.indexOf("=");
    if (index === -1) continue;
    parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature) return false;
  const millis = Number(timestamp) * 1000;
  if (!Number.isFinite(millis) || Math.abs(now - millis) > TOLERANCE_MS) return false;
  const expected = createHmac("sha256", signingKey).update(`${timestamp}.${rawBody}`).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function readLocation(location: { type?: string; join_url?: string; location?: string } | null | undefined): {
  locationType: MeetingLocationType;
  joinUrl: string;
} {
  const joinUrl = String(location?.join_url || location?.location || "");
  const type = String(location?.type || "");
  if (type === "google_conference") return { locationType: "google_conference", joinUrl };
  if (type === "microsoft_teams_conference" || type === "microsoft_teams" || type.toLowerCase().includes("teams")) {
    return { locationType: "microsoft_teams", joinUrl };
  }
  return { locationType: "unknown", joinUrl };
}

export function parseInviteeCreated(body: unknown): ParsedInvitee | null {
  if (!body || typeof body !== "object") return null;
  const event = body as {
    event?: string;
    payload?: {
      name?: string;
      email?: string;
      uri?: string;
      scheduled_event?: {
        uri?: string;
        name?: string;
        start_time?: string;
        event_type?: string;
        location?: { type?: string; join_url?: string; location?: string };
      };
    };
  };
  if (event.event !== "invitee.created" || !event.payload?.scheduled_event) return null;
  const scheduled = event.payload.scheduled_event;
  const location = readLocation(scheduled.location);
  if (!event.payload.email || !scheduled.start_time) return null;
  return {
    eventName: scheduled.name || "Termin",
    calendlyUri: scheduled.uri || event.payload.uri || "",
    eventTypeUri: scheduled.event_type || "",
    inviteeName: event.payload.name || event.payload.email,
    inviteeEmail: event.payload.email,
    startsAt: scheduled.start_time,
    joinUrl: location.joinUrl,
    locationType: location.locationType,
  };
}
