import { IntegrationError } from "@/lib/integration-error";

/**
 * Whether a failed import-list exclusion POST was refused only because the
 * exclusion already exists. Radarr, Sonarr and Lidarr all validate the id with
 * `ImportListExclusionExistsValidator` and answer a duplicate with a 400 whose
 * message is "This exclusion has already been added." — the outcome the
 * caller asked for, so it must not fail an action whose real work (an
 * unmonitor, a file delete) has already happened.
 */
export function isExistingExclusionError(error: unknown): boolean {
  return (
    error instanceof IntegrationError &&
    error.status === 400 &&
    error.validationMessages.length > 0 &&
    error.validationMessages.every((m) => /already been added/i.test(m))
  );
}
