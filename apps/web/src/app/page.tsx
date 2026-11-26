import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <p className="muted">Vertrieb zuerst</p>
        <h1>Ein Klon führt das Gespräch und lässt das Angebot als Entwurf liegen.</h1>
        <p>
          Stimme, Wissen und Preisliste gehören dem Unternehmer. Calendly startet den Termin, der Klon tritt
          Google Meet oder Teams bei und spricht zuerst den Hinweis, dass ein digitaler Klon spricht. Preise kommen
          nur aus der hinterlegten Liste. Reels bleiben in derselben App, ohne Upload zu Instagram oder TikTok.
        </p>
        <div className="row">
          <Link className="button" href="/login">
            Zum Dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
