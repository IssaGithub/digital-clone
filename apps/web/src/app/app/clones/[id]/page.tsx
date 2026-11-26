import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@klon/db";
import { addPrice, createReel, createTestBooking, deactivatePrice, updateClone } from "@/lib/actions";
import { currentUser } from "@/lib/session";

export default async function ClonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return null;
  const clone = await prisma.clone.findFirst({
    where: { id, userId: user.id },
    include: {
      priceItems: { where: { active: true }, orderBy: { name: "asc" } },
      plannedActions: true,
      reels: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!clone) notFound();
  return (
    <div className="stack">
      <h1>{clone.name}</h1>
      <form action={updateClone} className="card stack">
        <input type="hidden" name="id" value={clone.id} />
        <label>
          Name
          <input name="name" defaultValue={clone.name} />
        </label>
        <label>
          ElevenLabs-Stimme
          <input name="voiceId" defaultValue={clone.voiceId} />
        </label>
        <label>
          HeyGen-Avatar
          <input name="heygenAvatarId" defaultValue={clone.heygenAvatarId} />
        </label>
        <label>
          HeyGen-Stimme
          <input name="heygenVoiceId" defaultValue={clone.heygenVoiceId} />
        </label>
        <label>
          Wissen
          <textarea name="knowledge" defaultValue={clone.knowledge} />
        </label>
        <label>
          Gesprochener Hinweis
          <textarea name="disclosureText" defaultValue={clone.disclosureText} />
        </label>
        <label>
          Calendly-Event-Typ-URI
          <input name="calendlyEventTypeUri" defaultValue={clone.calendlyEventTypeUri} />
        </label>
        <label>
          Versandkanal
          <select name="preferredMail" defaultValue={clone.preferredMail}>
            <option value="auto">Gmail, sonst Outlook</option>
            <option value="gmail">Nur Gmail</option>
            <option value="outlook">Nur Outlook</option>
          </select>
        </label>
        <label className="row">
          <input type="checkbox" name="autoSendOffers" defaultChecked={clone.autoSendOffers} />
          Automatischer Versand nur bei vollständig klaren Positionen
        </label>
        <button type="submit">Klon speichern</button>
      </form>

      <section className="card">
        <h2>Preisliste</h2>
        <table>
          <thead>
            <tr>
              <th>Leistung</th>
              <th>Preis netto</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clone.priceItems.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  <div className="muted">{item.description}</div>
                </td>
                <td>
                  {(item.unitPriceCents / 100).toFixed(2)} {item.currency} / {item.unit}
                </td>
                <td>
                  <form action={deactivatePrice}>
                    <input type="hidden" name="id" value={item.id} />
                    <button className="ghost" type="submit">
                      Entfernen
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addPrice} className="stack">
          <input type="hidden" name="cloneId" value={clone.id} />
          <div className="row">
            <input name="name" placeholder="Leistung" required />
            <input name="euros" placeholder="Preis netto" required />
            <input name="unit" placeholder="Einheit" defaultValue="Stück" />
            <input name="taxPercent" placeholder="Steuer %" defaultValue="19" />
          </div>
          <input name="description" placeholder="Beschreibung" />
          <button type="submit">Position hinzufügen</button>
        </form>
      </section>

      <section className="card">
        <h2>Vorbereitete Aktionen</h2>
        <ul>
          {clone.plannedActions.map((action) => (
            <li key={action.id}>
              <strong>{action.type}</strong> {action.enabled ? "aktiv" : "inaktiv"} — {action.note}
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack">
        <h2>Reel</h2>
        <p className="muted">Briefing wird zu Skript, ElevenLabs-Text und vertikalem HeyGen-Video. Download nur hier.</p>
        <form action={createReel} className="stack">
          <input type="hidden" name="cloneId" value={clone.id} />
          <textarea name="briefing" placeholder="Worum geht das Reel?" required />
          <button type="submit">Reel erzeugen</button>
        </form>
        {clone.reels.map((reel) => (
          <Link key={reel.id} href={`/app/reels/${reel.id}`}>
            {reel.status}: {reel.briefing.slice(0, 80)}
          </Link>
        ))}
      </section>

      <section className="card stack">
        <h2>Lokale Testbuchung</h2>
        <p className="muted">Legt eine Buchung an und stellt den Bot-Start in die Warteschlange. Calendly bleibt der echte Weg.</p>
        <form action={createTestBooking} className="stack">
          <input type="hidden" name="cloneId" value={clone.id} />
          <input name="inviteeName" placeholder="Name" />
          <input name="inviteeEmail" type="email" placeholder="E-Mail" />
          <input name="startsAt" type="datetime-local" />
          <select name="locationType" defaultValue="google_conference">
            <option value="google_conference">Google Meet</option>
            <option value="microsoft_teams">Microsoft Teams</option>
          </select>
          <input name="joinUrl" placeholder="https://meet.google.com/..." />
          <button type="submit">Bot einplanen</button>
        </form>
      </section>
    </div>
  );
}
