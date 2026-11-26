import { login } from "@/lib/actions";
import { sessionReady } from "@/lib/session";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ fehler?: string }> }) {
  const query = await searchParams;
  const ready = sessionReady();
  return (
    <main>
      <h1>Anmelden</h1>
      {!ready ? (
        <p className="bad">SESSION_SECRET oder ENCRYPTION_KEY fehlt. Lege im Projektroot eine .env an (`npm run env:init`).</p>
      ) : null}
      {query.fehler === "passwort" ? <p className="bad">Passwort stimmt nicht.</p> : null}
      <form action={login} className="card" style={{ maxWidth: 420 }}>
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          E-Mail
          <input name="email" type="email" required />
        </label>
        {process.env.DASHBOARD_PASSWORD ? (
          <label>
            Passwort
            <input name="password" type="password" required />
          </label>
        ) : (
          <p className="muted">Ohne DASHBOARD_PASSWORD ist die Anmeldung lokal offen.</p>
        )}
        <button type="submit" disabled={!ready}>
          Weiter
        </button>
      </form>
    </main>
  );
}
