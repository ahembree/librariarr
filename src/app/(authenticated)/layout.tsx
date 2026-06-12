import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isSessionValid } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ChipColorProvider } from "@/components/chip-color-provider";
import { AuthenticatedShell } from "@/components/authenticated-shell";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // If no users exist, redirect to login (which has inline setup form)
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    redirect("/login");
  }

  const valid = await isSessionValid();
  if (!valid) {
    redirect("/api/auth/logout");
  }

  // Read the sidebar preference server-side so SSR HTML matches the
  // client's first render (a client-only localStorage read tripped
  // hydration for anyone with a collapsed sidebar).
  const cookieStore = await cookies();
  const sidebarCollapsed = cookieStore.get("sidebar-collapsed")?.value === "1";

  return (
    <ChipColorProvider>
      <AuthenticatedShell initialSidebarCollapsed={sidebarCollapsed}>
        {children}
      </AuthenticatedShell>
    </ChipColorProvider>
  );
}
