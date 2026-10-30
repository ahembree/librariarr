import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getRequestSession, loadShellSettings } from "@/lib/settings/shell-settings";
import { ChipColorProvider } from "@/components/chip-color-provider";
import { ShellSettingsProvider } from "@/components/shell-settings-provider";
import { AuthenticatedShell } from "@/components/authenticated-shell";
import { MobileGuessProvider } from "@/components/mobile-guess-provider";
import { isLikelyPhone } from "@/lib/device";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The root layout already read the session for the accent; this is the same
  // read, not a second one.
  const session = await getRequestSession();
  if (!session.isLoggedIn || !session.userId) {
    // If no users exist, redirect to login (which has inline setup form)
    const userCount = await prisma.user.count();
    redirect(userCount === 0 ? "/login" : "/api/auth/logout");
  }

  // The display settings the shell and its pages render — chip colours, the
  // user chip, table columns, card toggles, the dashboard layout, whether the
  // "What's new" dialog is owed — read here so they are in the first paint.
  // Fetched client-side after hydration, each one drew its defaults first. A
  // failed read leaves them to fetch their own, as before.
  const settings = await loadShellSettings(session.userId).catch(() => null);

  // Read the sidebar preference server-side so SSR HTML matches the
  // client's first render (a client-only localStorage read tripped
  // hydration for anyone with a collapsed sidebar).
  const cookieStore = await cookies();
  const sidebarCollapsed = cookieStore.get("sidebar-collapsed")?.value === "1";

  // Lay a phone out as a phone before hydration: the server cannot see the
  // screen, and the desktop sidebar took most of a phone's width until the
  // page had hydrated (see `isLikelyPhone`).
  const requestHeaders = await headers();
  const likelyPhone = isLikelyPhone(requestHeaders.get("user-agent"), requestHeaders.get("sec-ch-ua-mobile"));

  return (
    <ShellSettingsProvider initial={settings}>
      <ChipColorProvider>
        <MobileGuessProvider guess={likelyPhone}>
          <AuthenticatedShell initialSidebarCollapsed={sidebarCollapsed}>
            {children}
          </AuthenticatedShell>
        </MobileGuessProvider>
      </ChipColorProvider>
    </ShellSettingsProvider>
  );
}
