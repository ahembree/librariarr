import { redirect } from "next/navigation";
import { getRequestSession } from "@/lib/settings/shell-settings";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The same per-request read the root layout made for the accent.
  const session = await getRequestSession();
  if (!session.isLoggedIn || !session.userId) redirect("/login");
  return <>{children}</>;
}
