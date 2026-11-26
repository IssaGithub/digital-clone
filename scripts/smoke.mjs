import { prisma } from "@klon/db";
import { enqueue, processNextJob } from "@klon/domain";
import { newUserSalt } from "@klon/core";

const user = await prisma.user.create({
  data: { email: `smoke-${Date.now()}@example.com`, name: "Smoke", encryptionSalt: newUserSalt() },
});
const clone = await prisma.clone.create({
  data: {
    userId: user.id,
    name: "Ada",
    disclosureText: "Hinweis: digitaler Klon.",
    priceItems: { create: [{ name: "Workshop", unitPriceCents: 120000, unit: "Tag" }] },
    plannedActions: { create: [{ type: "github_project", enabled: false, note: "vorbereitet" }] },
  },
});
const booking = await prisma.booking.create({
  data: {
    cloneId: clone.id,
    inviteeName: "Kunde",
    inviteeEmail: "kunde@example.com",
    startsAt: new Date(),
    joinUrl: "",
    locationType: "unknown",
    status: "scheduled",
  },
});
await prisma.callSession.create({
  data: {
    bookingId: booking.id,
    status: "ended",
    transcript: "Wir brauchen 2 Workshop. Außerdem noch ein Extra-Podcast.",
  },
});
await enqueue("draft_offer", { bookingId: booking.id });
await processNextJob();
const offer = await prisma.offer.findUnique({ where: { bookingId: booking.id } });
const lines = offer?.lines ?? [];
const unclear = Array.isArray(lines) && lines.some((line) => line.unclear && line.unitPriceCents == null);
const priced = Array.isArray(lines) && lines.some((line) => line.priceItemId && line.unitPriceCents === 120000 && line.quantity === 2);
if (!offer || offer.status !== "draft" || !unclear || !priced || offer.lexwareQuotationId) {
  console.error(JSON.stringify(offer, null, 2));
  process.exitCode = 1;
} else {
  console.log("smoke ok", offer.blockedReason);
}
await prisma.user.delete({ where: { id: user.id } });
await prisma.$disconnect();
