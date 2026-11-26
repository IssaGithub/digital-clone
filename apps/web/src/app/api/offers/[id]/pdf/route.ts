import { readFile } from "node:fs/promises";
import { prisma } from "@klon/db";
import { currentUser } from "@/lib/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await currentUser();
  if (!user) return new Response("Nicht angemeldet", { status: 401 });
  const offer = await prisma.offer.findFirst({
    where: { id, clone: { userId: user.id } },
  });
  if (!offer?.pdfPath) return new Response("PDF fehlt", { status: 404 });
  const pdf = await readFile(offer.pdfPath);
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="angebot-${offer.id}.pdf"`,
    },
  });
}
