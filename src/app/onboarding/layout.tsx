import { redirect } from "next/navigation";
import { isSessionValid } from "@/lib/auth/session";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const valid = await isSessionValid();
  if (!valid) redirect("/login");
  return <>{children}</>;
}
