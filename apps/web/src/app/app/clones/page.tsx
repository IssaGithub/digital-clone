import Link from "next/link";
import { prisma } from "@klon/db";
import { currentUser } from "@/lib/session";

export default async function ClonesPage() {
  const user = await currentUser();
  if (!user) return null;
  const clones = await prisma.clone.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { priceItems: true } } },
  });
  return (
    <div className="stack">
      <div className="row">
        <h1>Klone</h1>
        <Link className="button" href="/app/clones/new">
          Klon anlegen
        </Link>
      </div>
      {clones.length === 0 ? <p>Noch keiner. Lege Stimme, Wissen und Preise an.</p> : null}
      <div className="grid">
        {clones.map((clone) => (
          <Link key={clone.id} className="card" href={`/klon/${clone.id}`}>
            <h2>{clone.name}</h2>
            <p className="muted">{clone._count.priceItems} Preispositionen</p>
            <p>{clone.autoSendOffers ? "Automatischer Versand an" : "Versand nur nach Freigabe"}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
