import { describe, it, expect } from "vitest";
import { isLikelyPhone } from "@/lib/device";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

describe("isLikelyPhone", () => {
  it("takes iPhones and Android phones for phones", () => {
    expect(isLikelyPhone(IPHONE, null)).toBe(true);
    expect(isLikelyPhone(ANDROID_PHONE, null)).toBe(true);
  });

  it("leaves tablets and desktops on the desktop layout", () => {
    expect(isLikelyPhone(ANDROID_TABLET, null)).toBe(false);
    expect(isLikelyPhone(IPAD, null)).toBe(false);
    expect(isLikelyPhone(DESKTOP, "?0")).toBe(false);
  });

  it("trusts Chromium's mobile hint", () => {
    expect(isLikelyPhone(DESKTOP, "?1")).toBe(true);
  });

  it("guesses desktop with nothing to go on", () => {
    expect(isLikelyPhone(null, null)).toBe(false);
  });
});
