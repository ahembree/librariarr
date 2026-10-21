import { parseReleaseBody } from "@/lib/version/release-notes";

/** A release-please body as headed bullet lists. */
export function ReleaseNoteSections({ body }: { body: string }) {
  const sections = parseReleaseBody(body);

  if (sections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No release notes available.
      </p>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <div key={section.heading}>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            {section.heading}
          </h4>
          <ul className="space-y-1">
            {section.items.map((item, i) => (
              <li
                key={i}
                className="text-sm text-foreground/80 flex gap-2"
              >
                <span className="text-muted-foreground mt-1 shrink-0">
                  &bull;
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
