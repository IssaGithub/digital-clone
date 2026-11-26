import Link from "next/link";
import { notFound } from "next/navigation";
import type { DraftLine } from "@klon/core";
import { canFinalize } from "@klon/core";
import { prisma } from "@klon/db";
import { dropUnclear, releaseOffer, sendAgain } from "@/lib/actions";
import { currentUser } from "@/lib/session";

export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return null;
  const offer = await prisma.offer.findFirst({
    where: { id, clone: { userId: user.id } },
    include: { clone: true },
  });
  if (!offer) notFound();
  const lines = offer.lines as DraftLine[];
  const ready = canFinalize(lines) && offer.status === "draft";
  return (
    <div className="stack">
      <h1>Angebot an {offer.customerName}</h1>
      <p>
        {offer.customerEmail} · {offer.status}
        {offer.mailChannel !== "none" ? ` · ${offer.mailChannel}` : ""}
      </p>
      {offer.blockedReason ? <p className="warn">{offer.blockedReason}</p> : null}
      {offer.lastError ? <p className="bad">{offer.lastError}</p> : null}
      {offer.lexwareQuotationId ? <p>Lexware-Entwurf {offer.lexwareQuotationId}</p> : null}
      {offer.lexwareFinalId ? <p>Lexware final {offer.lexwareFinalId}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Position</th>
            <th>Menge</th>
            <th>Preis</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <td>
                {line.label}
                {line.unclear ? <div className="warn">{line.reason}</div> : null}
                {line.dropped ? <div className="muted">nicht übernommen</div> : null}
              </td>
              <td>{line.quantity}</td>
              <td>{line.unitPriceCents == null ? "—" : `${(line.unitPriceCents / 100).toFixed(2)} ${line.currency}`}</td>
              <td>
                {line.unclear && !line.dropped && offer.status === "draft" ? (
                  <form action={dropUnclear}>
                    <input type="hidden" name="offerId" value={offer.id} />
                    <input type="hidden" name="lineId" value={line.id} />
                    <button className="ghost" type="submit">
                      Nicht übernehmen
                    </button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ready ? (
        <form action={releaseOffer}>
          <input type="hidden" name="offerId" value={offer.id} />
          <button type="submit">Freigeben, finalisieren und senden</button>
        </form>
      ) : null}
      {offer.pdfPath ? (
        <div className="row">
          <a className="button" href={`/api/offers/${offer.id}/pdf`}>
            PDF laden
          </a>
          {offer.status !== "sent" ? (
            <form action={sendAgain}>
              <input type="hidden" name="offerId" value={offer.id} />
              <button type="submit">Erneut senden</button>
            </form>
          ) : (
            <span className="ok">Gesendet an {offer.sentTo}</span>
          )}
        </div>
      ) : null}
      <Link href="/app/buchungen">Zurück</Link>
    </div>
  );
}
