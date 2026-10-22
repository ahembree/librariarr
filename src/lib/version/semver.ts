/** Client-safe: no Node or server imports. */

/**
 * Compare two semver strings (major.minor.patch).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  // Strip build metadata (+...) — it does not affect precedence — then split
  // off any pre-release (-...), which does. Avoids corrupting the numeric core.
  const parse = (v: string) => {
    const withoutBuild = v.replace(/^v/, "").split("+", 1)[0];
    const [core, pre] = withoutBuild.split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { nums, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < 3; i++) {
    const va = pa.nums[i] ?? 0;
    const vb = pb.nums[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  // Same core version: a pre-release ranks below the final release (1.2.0-rc1 < 1.2.0).
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) {
    if (pa.pre < pb.pre) return -1;
    if (pa.pre > pb.pre) return 1;
  }
  return 0;
}
