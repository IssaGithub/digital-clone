import Link from "next/link";
import { prisma } from "@klon/db";
import { currentUser } from "@/lib/session";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) return null;
  const [clones, bookings, offers, reels] = await Promise.all([
    prisma.clone.count({ where: { userId: user.id } }),
    prisma.booking.count({ where: { clone: { userId: user.id } } }),
    prisma.offer.count({ where: { clone: { userId: user.id }, status: "draft" } }),
    prisma.reel.count({ where: { clone: { userId: user.id }, status: "ready" } }),
  ]);
  return (
    <div className="stack">
      <h1>Guten Tag, {user.name}</h1>
      <div className="grid">
        <Link className="card" href="/app/clones">
          <h2>{clones}</h2>
          <p>Klone mit Stimme, Wissen und Preisliste</p>
        </Link>
        <Link className="card" href="/app/buchungen">
          <h2>{bookings}</h2>
          <p>Termine</p>
        </Link>
        <div className="card">
          <h2>{offers}</h2>
          <p>Angebotsentwürfe warten auf Freigabe</p>
        </div>
        <div className="card">
          <h2>{reels}</h2>
          <p>Reels zum Download</p>
        </div>
      </div>
    </div>
  );
}
