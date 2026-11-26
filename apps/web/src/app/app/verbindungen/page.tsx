import { CONNECTION_PROVIDERS } from "@klon/core";
import { prisma } from "@klon/db";
import { missingPlatformEnv, webhookUrl } from "@klon/domain";
import { disconnect, saveConnection } from "@/lib/actions";
import { currentUser } from "@/lib/session";

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ fehler?: string; hinweis?: string }> }) {
  const user = await currentUser();
  if (!user) return null;
  const query = await searchParams;
  const connections = await prisma.connection.findMany({ where: { userId: user.id } });
  const byProvider = new Map(connections.map((item) => [item.provider, item]));
  return (
    <div className="stack">
      <h1>Verbindungen</h1>
      {query.fehler === "schluessel" ? <p className="bad">ENCRYPTION_KEY fehlt. Secrets werden nicht gespeichert.</p> : null}
      {query.hinweis ? <p className="warn">{query.hinweis}</p> : null}
      <p className="muted">
        Calendly-Webhook: <code>{webhookUrl(user.id)}</code>
      </p>
      <div className="grid">
        {CONNECTION_PROVIDERS.map((provider) => {
          const connection = byProvider.get(provider.id);
          const missingEnv = provider.mode === "oauth" ? missingPlatformEnv(provider.env) : [];
          const connected = Boolean(connection?.connected);
          return (
            <article key={provider.id} className="card stack">
              <div className="row">
                <h2>{provider.label}</h2>
                <span className={connected ? "pill ok" : "pill warn"}>{connected ? "angeschlossen" : "fehlender Anschluss"}</span>
              </div>
              <p className="muted">{provider.blurb}</p>
              {connection?.accountLabel ? <p>{connection.accountLabel}</p> : null}
              {missingEnv.length ? (
                <p className="bad">Plattform-OAuth fehlt: {missingEnv.join(", ")}</p>
              ) : null}
              {provider.mode === "oauth" ? (
                missingEnv.length ? (
                  <button type="button" disabled>
                    Verbinden
                  </button>
                ) : (
                  <a className="button" href={`/api/oauth/${provider.id}`}>
                    {connected ? "Erneut verbinden" : "Verbinden"}
                  </a>
                )
              ) : (
                <form action={saveConnection} className="stack">
                  <input type="hidden" name="provider" value={provider.id} />
                  {provider.fields.map((field) => (
                    <label key={field.key}>
                      {field.label}
                      <input
                        name={field.key}
                        type={field.secret ? "password" : "text"}
                        placeholder={"placeholder" in field ? field.placeholder : "neuen Wert eintragen"}
                        autoComplete="off"
                      />
                    </label>
                  ))}
                  <button type="submit">Speichern</button>
                </form>
              )}
              {connected ? (
                <form action={disconnect}>
                  <input type="hidden" name="provider" value={provider.id} />
                  <button className="ghost" type="submit">
                    Trennen
                  </button>
                </form>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
