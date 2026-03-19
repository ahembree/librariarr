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

  return (
    <ChipColorProvider>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </ChipColorProvider>
  );
}
