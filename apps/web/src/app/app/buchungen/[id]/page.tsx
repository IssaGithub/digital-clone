import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@klon/db";
import { simulateCall } from "@/lib/actions";
import { currentUser } from "@/lib/session";

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return null;
  const booking = await prisma.booking.findFirst({
    where: { id, clone: { userId: user.id } },
    include: { clone: true, callSession: true, offer: true },
  });
  if (!booking) notFound();
  return (
    <div className="stack">
      <h1>{booking.inviteeName}</h1>
      <p>
        {booking.inviteeEmail} · {booking.locationType} · {booking.status}
      </p>
      {booking.joinUrl ? <p>{booking.joinUrl}</p> : <p className="warn">Kein Beitrittslink.</p>}
      {booking.callSession ? (
        <section className="card">
          <h2>Call {booking.callSession.status}</h2>
          <p>Hinweis gesprochen: {booking.callSession.disclosurePlayed ? "ja" : "noch nicht"}</p>
          {booking.callSession.recallBotId ? <p>Recall-Bot {booking.callSession.recallBotId}</p> : null}
          {booking.callSession.lastError ? <p className="bad">{booking.callSession.lastError}</p> : null}
          <pre>{booking.callSession.transcript || "Noch kein Transkript."}</pre>
        </section>
      ) : (
        <p>Der Bot-Job hat noch keine Sitzung geschrieben.</p>
      )}
      {booking.offer ? (
        <Link className="button" href={`/app/angebote/${booking.offer.id}`}>
          Angebot öffnen
        </Link>
      ) : (
        <form action={simulateCall} className="card stack">
          <h2>Lokales Transkript</h2>
          <p className="muted">Ohne laufenden Call kannst du ein Gespräch einsetzen. Der Entwurf nutzt nur die Preisliste.</p>
          <input type="hidden" name="bookingId" value={booking.id} />
          <textarea name="transcript" required placeholder="Kunde: Wir brauchen 2 Workshop. Außerdem noch ein Podcast." />
          <button type="submit">Angebot entwerfen</button>
        </form>
      )}
    </div>
  );
}
