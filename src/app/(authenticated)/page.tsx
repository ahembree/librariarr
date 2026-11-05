import { headers } from "next/headers";
import { isDocumentRequest } from "@/lib/document-request";
import { getRequestSession, loadShellSettings } from "@/lib/settings/shell-settings";
import { loadDashboardSeed, serverClock } from "@/lib/dashboard/load-dashboard-seed";
import { DashboardSeedProvider } from "@/components/dashboard/dashboard-seed";
import type { DashboardSeed } from "@/lib/dashboard/dashboard-seed-types";
import { DashboardPage } from "./dashboard-page";

/**
 * On a full page load the dashboard's figures are read here and rendered into
 * the HTML (`loadDashboardSeed`). The page used to render skeletons and ask
 * for every figure only once its script had run and hydrated, which on a phone
 * was over a second after the HTML arrived.
 *
 * A client-side navigation or a prefetch fetches the page's RSC payload
 * (`isDocumentRequest` tells the two apart): the page there renders as before
 * and fetches its own data, so a prefetched copy, which the router may show
 * minutes later, holds no figures to go stale.
 */
export default async function Dashboard() {
  const seed = isDocumentRequest(await headers()) ? await readSeed() : null;
  return (
    <DashboardSeedProvider seed={seed} clock={serverClock()}>
      <DashboardPage />
    </DashboardSeedProvider>
  );
}

async function readSeed(): Promise<DashboardSeed | null> {
  const session = await getRequestSession();
  // Signed out: the layout redirects.
  if (!session.isLoggedIn || !session.userId) return null;
  const settings = await loadShellSettings(session.userId).catch(() => null);
  return loadDashboardSeed(settings?.libraryTypes.types ?? []);
}
