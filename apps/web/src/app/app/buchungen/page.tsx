import Link from "next/link";
import { prisma } from "@klon/db";
import { currentUser } from "@/lib/session";

export default async function BookingsPage() {
  const user = await currentUser();
  if (!user) return null;
  const bookings = await prisma.booking.findMany({
    where: { clone: { userId: user.id } },
    include: { clone: true, offer: true, callSession: true },
    orderBy: { startsAt: "desc" },
  });
  return (
    <div className="stack">
      <h1>Buchungen</h1>
      {bookings.length === 0 ? <p>Noch keine. Calendly schreibt sie über den Webhook.</p> : null}
      <div className="stack">
        {bookings.map((booking) => (
          <Link key={booking.id} className="card" href={`/app/buchungen/${booking.id}`}>
            <strong>{booking.inviteeName}</strong> · {booking.clone.name}
            <div className="muted">
              {booking.startsAt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} · {booking.locationType} · {booking.status}
              {booking.offer ? ` · Angebot ${booking.offer.status}` : ""}
              {booking.callSession?.lastError ? ` · ${booking.callSession.lastError}` : ""}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
