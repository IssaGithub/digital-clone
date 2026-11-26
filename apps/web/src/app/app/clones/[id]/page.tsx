import { redirect } from "next/navigation";

export default async function CloneRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/klon/${id}`);
}
