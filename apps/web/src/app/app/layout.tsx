import Link from "next/link";
import { redirect } from "next/navigation";
import { logout } from "@/lib/actions";
import { currentUser } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <>
      <nav className="nav">
        <Link className="brand" href="/app">
          Klon
        </Link>
        <Link href="/app/clones">Klone</Link>
        <Link href="/app/buchungen">Buchungen</Link>
        <Link href="/app/verbindungen">Verbindungen</Link>
        <form action={logout}>
          <button className="ghost" type="submit">
            Abmelden
          </button>
        </form>
      </nav>
      <main>{children}</main>
    </>
  );
}
