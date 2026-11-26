import { readFile } from "node:fs/promises";
import { prisma } from "@klon/db";
import { currentUser } from "@/lib/session";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await currentUser();
  if (!user) return new Response("Nicht angemeldet", { status: 401 });
  const reel = await prisma.reel.findFirst({ where: { id, clone: { userId: user.id } } });
  if (!reel) return new Response("Reel fehlt", { status: 404 });
  const kind = new URL(request.url).searchParams.get("kind");
  const path = kind === "audio" ? reel.voiceAudioPath : reel.videoPath;
  if (!path) return new Response("Datei fehlt", { status: 404 });
  const file = await readFile(path);
  const video = kind !== "audio";
  return new Response(file, {
    headers: {
      "Content-Type": video ? "video/mp4" : "audio/mpeg",
      "Content-Disposition": `attachment; filename="${video ? "reel" : "sprecher"}-${reel.id}.${video ? "mp4" : "mp3"}"`,
    },
  });
}
