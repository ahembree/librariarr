import { describe, it, expect } from "vitest";
import { cleanDescription } from "@/lib/trash/status";

describe("cleanDescription", () => {
  it("returns undefined for empty / whitespace-only input", () => {
    expect(cleanDescription(undefined)).toBeUndefined();
    expect(cleanDescription("")).toBeUndefined();
    expect(cleanDescription("   ")).toBeUndefined();
    expect(cleanDescription("<span></span>")).toBeUndefined();
  });

  it("renders <br> variants as a separator and strips tags", () => {
    expect(cleanDescription("Line one<br>Line two")).toBe("Line one · Line two");
    expect(cleanDescription("A<br />B<BR/>C")).toBe("A · B · C");
    expect(cleanDescription("<b>Bold</b> and <i>italic</i>")).toBe("Bold and italic");
  });

  it("leaves no angle brackets, even for dangling/incomplete tags", () => {
    // A single-pass tag strip would leave the unclosed "<script"; the extra
    // angle-bracket sweep guarantees nothing HTML-shaped survives.
    const out = cleanDescription("hello <script");
    expect(out).toBe("hello script");
    expect(out).not.toContain("<");

    const attr = cleanDescription("<img src=x onerror=alert(1)");
    expect(attr).not.toContain("<");
  });

  it("fully removes tags that a single pass would splice back together", () => {
    // Removing the inner <script> from "<scr<script>ipt>" would re-form "<script>";
    // the fixpoint loop must keep going until no tag remains.
    for (const input of [
      "<scr<script>ipt>alert(1)</script>",
      "<<script>script>alert(1)<</script>/script>",
      "a<b<b>c>d",
    ]) {
      const out = cleanDescription(input) ?? "";
      expect(out).not.toContain("<");
      expect(out).not.toContain(">");
    }
  });
});
