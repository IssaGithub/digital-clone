import { notFound } from "next/navigation";
import { prisma } from "@klon/db";
import { currentUser } from "@/lib/session";

export default async function ReelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return null;
  const reel = await prisma.reel.findFirst({
    where: { id, clone: { userId: user.id } },
    include: { clone: true },
  });
  if (!reel) notFound();
  return (
    <div className="stack">
      <h1>Reel · {reel.clone.name}</h1>
      <p>
        Status: {reel.status}. Kein Upload zu Instagram oder TikTok.
      </p>
      {reel.lastError ? <p className="bad">{reel.lastError}</p> : null}
      <section className="card">
        <h2>Briefing</h2>
        <p>{reel.briefing}</p>
        <h2>Skript</h2>
        <pre>{reel.script || "Noch leer."}</pre>
        <h2>ElevenLabs-Text</h2>
        <pre>{reel.voiceText || "Noch leer."}</pre>
      </section>
      <div className="row">
        {reel.videoPath ? (
          <a className="button" href={`/api/reels/${reel.id}/file?kind=video`}>
            Video laden
          </a>
        ) : null}
        {reel.voiceAudioPath ? (
          <a className="button ghost" href={`/api/reels/${reel.id}/file?kind=audio`}>
            Sprecherdatei laden
          </a>
        ) : null}
      </div>
    </div>
  );
}
