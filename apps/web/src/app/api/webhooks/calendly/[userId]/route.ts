import { parseInviteeCreated, verifyCalendlySignature, loadEnv } from "@klon/core";
import { prisma } from "@klon/db";
import { enqueue, readSecrets } from "@klon/domain";

loadEnv();

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return new Response("Unbekannt", { status: 404 });
  const raw = await request.text();
  const secret = await readSecrets(userId, "calendly");
  const header = request.headers.get("calendly-webhook-signature");
  if (!secret?.webhookSigningKey || !verifyCalendlySignature(raw, header, secret.webhookSigningKey)) {
    return new Response("Signatur ungültig", { status: 401 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Response("JSON ungültig", { status: 400 });
  }
  const invitee = parseInviteeCreated(json);
  if (!invitee) return Response.json({ ignored: true });
  const clones = await prisma.clone.findMany({ where: { userId } });
  const clone =
    clones.find((item) => item.calendlyEventTypeUri && item.calendlyEventTypeUri === invitee.eventTypeUri) ||
    (clones.length === 1 ? clones[0] : undefined);
  if (!clone) return new Response("Kein passender Klon", { status: 422 });
  const existing = invitee.calendlyUri
    ? await prisma.booking.findFirst({ where: { calendlyUri: invitee.calendlyUri, cloneId: clone.id } })
    : null;
  if (existing) return Response.json({ ok: true, duplicate: true });
  const booking = await prisma.booking.create({
    data: {
      cloneId: clone.id,
      calendlyUri: invitee.calendlyUri,
      inviteeName: invitee.inviteeName,
      inviteeEmail: invitee.inviteeEmail,
      startsAt: new Date(invitee.startsAt),
      joinUrl: invitee.joinUrl,
      locationType: invitee.locationType,
      rawEvent: json as object,
      status: "scheduled",
    },
  });
  await enqueue("start_bot", { bookingId: booking.id });
  return Response.json({ ok: true, bookingId: booking.id });
}
