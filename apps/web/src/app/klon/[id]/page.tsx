import Link from "next/link";
import { notFound } from "next/navigation";
import { appUrl } from "@klon/core";
import { prisma } from "@klon/db";
import { addMcpServer, addPrice, createReel, deactivatePrice, removeMcpServer, updateClone } from "@/lib/actions";
import { currentUser } from "@/lib/session";

function calendlyEmbed(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith("calendly.com")) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export default async function ClonePublicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const clone = await prisma.clone.findUnique({
    where: { id },
    include: {
      priceItems: { where: { active: true }, orderBy: { name: "asc" } },
      mcpServers: { orderBy: { createdAt: "asc" } },
      reels: { orderBy: { createdAt: "desc" }, take: 6 },
    },
  });
  if (!clone) notFound();
  const owner = user?.id === clone.userId;
  const embed = calendlyEmbed(clone.calendlySchedulingUrl);
  const publicUrl = `${appUrl()}/klon/${clone.id}`;
  return (
    <main>
      <div className="row">
        <h1 style={{ marginRight: "auto" }}>{clone.name}</h1>
        {user ? <Link href="/app">Dashboard</Link> : <Link href="/login">Anmelden</Link>}
      </div>
      <p className="muted">Digitaler Klon. Ein gebuchter Termin läuft in Google Meet oder Microsoft Teams.</p>

      {owner ? (
        <section className="stack" style={{ marginTop: 20 }}>
          <h2>Konfiguration</h2>
          <p className="muted">Nur für dich sichtbar. Öffentliche Buchungsadresse: {publicUrl}</p>
          <form action={updateClone} className="card stack">
            <input type="hidden" name="id" value={clone.id} />
            <label>
              Name
              <input name="name" defaultValue={clone.name} required />
            </label>
            <label>
              Wissen
              <textarea name="knowledge" defaultValue={clone.knowledge} />
            </label>
            <label>
              ElevenLabs-Stimme
              <input name="voiceId" defaultValue={clone.voiceId} />
            </label>
            <label>
              Gesprochener Hinweis zu Beginn
              <textarea name="disclosureText" defaultValue={clone.disclosureText} />
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
              Calendly-Link für die Buchung
              <input name="calendlySchedulingUrl" defaultValue={clone.calendlySchedulingUrl} placeholder="https://calendly.com/..." />
            </label>
            <label>
              Calendly-Event-Typ-URI für den Webhook
              <input name="calendlyEventTypeUri" defaultValue={clone.calendlyEventTypeUri} />
            </label>
            <label>
              Versand
              <select name="preferredMail" defaultValue={clone.preferredMail}>
                <option value="auto">Gmail, sonst Outlook</option>
                <option value="gmail">Nur Gmail</option>
                <option value="outlook">Nur Outlook</option>
              </select>
            </label>
            <label className="row">
              <input type="checkbox" name="autoSendOffers" defaultChecked={clone.autoSendOffers} />
              Automatischer Versand nur bei klaren Preispositionen
            </label>
            <button type="submit">Klon speichern</button>
          </form>

          <section className="card">
            <h2>Preisliste</h2>
            <table>
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
              </div>
              <button type="submit">Position hinzufügen</button>
            </form>
          </section>

          <section className="card stack">
            <h2>MCP-Server</h2>
            <p className="muted">
              Im Call listet der Klon die Werkzeuge und kann sie mit Namen und Argumenten aufrufen. Ein unerreichbarer Server bleibt hier sichtbar, der Call läuft weiter.
            </p>
            {clone.mcpServers.map((server) => (
              <div key={server.id} className="row">
                <strong>{server.name}</strong>
                <span className={server.reachable ? "pill ok" : "pill warn"}>
                  {server.reachable ? "erreichbar" : server.lastError ? "nicht erreichbar" : "noch nicht geprüft"}
                </span>
                <span className="muted">{server.url}</span>
                {server.toolNames ? <span>{server.toolNames}</span> : null}
                {server.lastError ? <span className="bad">{server.lastError}</span> : null}
                <form action={removeMcpServer}>
                  <input type="hidden" name="id" value={server.id} />
                  <button className="ghost" type="submit">
                    Entfernen
                  </button>
                </form>
              </div>
            ))}
            <form action={addMcpServer} className="stack">
              <input type="hidden" name="cloneId" value={clone.id} />
              <input name="name" placeholder="Name" required />
              <input name="url" placeholder="https://mcp.example.com/mcp" required />
              <input name="token" type="password" placeholder="Optionaler Token" autoComplete="off" />
              <textarea name="headers" placeholder={"Optional weitere Header, eine Zeile je Header\nX-Workspace: 123"} />
              <button type="submit">MCP-Server hinzufügen</button>
            </form>
          </section>

          <section className="card stack">
            <h2>Video-Briefing</h2>
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
        </section>
      ) : null}

      <section className="stack" style={{ marginTop: 28 }}>
        <h2>Buchung</h2>
        <p>Wähle einen Termin. Danach spricht dieser Klon mit dir in Google Meet oder Microsoft Teams.</p>
        {embed ? (
          <iframe title={`Termin mit ${clone.name}`} src={embed} style={{ width: "100%", minHeight: 720, border: 0, background: "white" }} />
        ) : clone.calendlySchedulingUrl ? (
          <a className="button" href={clone.calendlySchedulingUrl}>
            Termin buchen
          </a>
        ) : (
          <p className="warn">Für diesen Klon ist noch kein Calendly-Link hinterlegt.</p>
        )}
      </section>
    </main>
  );
}
