import { describe, it, expect } from "vitest";
import { API_KEY_NAME_MAX_LENGTH, apiKeyNameProblem } from "@/lib/api-keys/name-rules";

describe("apiKeyNameProblem", () => {
  it("accepts an ordinary name", () => {
    expect(apiKeyNameProblem("Home Assistant")).toBeNull();
  });

  it("requires a name", () => {
    expect(apiKeyNameProblem("")).toBe("Name is required");
  });

  it("caps the length", () => {
    expect(apiKeyNameProblem("x".repeat(API_KEY_NAME_MAX_LENGTH))).toBeNull();
    expect(apiKeyNameProblem("x".repeat(API_KEY_NAME_MAX_LENGTH + 1))).toBe(
      `Name must be ${API_KEY_NAME_MAX_LENGTH} characters or fewer`,
    );
  });

  it.each([
    ["a newline (forges a log line)", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a next-line control", "a\u0085b"],
    ["a line separator", "a b"],
    ["a paragraph separator", "a b"],
    ["a right-to-left override", "a‮b"],
    ["a left-to-right mark", "a‎b"],
    ["an Arabic letter mark", "a؜b"],
    ["a first-strong isolate", "a⁨b"],
    ["a zero-width space", "a​b"],
    ["a word joiner", "a⁠b"],
    ["a byte-order mark", "a﻿b"],
    ["a soft hyphen", "a­b"],
  ])("refuses %s", (_label, name) => {
    expect(apiKeyNameProblem(name)).toBe(
      "Name cannot contain control characters, direction overrides or invisible characters",
    );
  });

  it("refuses a name with nothing visible in it", () => {
    expect(apiKeyNameProblem("‍")).toBe("Name must contain a visible character");
    expect(apiKeyNameProblem("️‍")).toBe("Name must contain a visible character");
  });

  it.each([
    ["accents and punctuation", "Café dashboard (v2) — beta"],
    ["an emoji", "📺 TV"],
    ["an emoji built with zero-width joiners", "🏳️‍🌈 Pride"],
    ["a skin-tone emoji", "👍🏽 Approvals"],
    ["a flag", "🇳🇱 Server"],
    ["a non-Latin script", "Домашний сервер"],
    ["a script that uses a zero-width non-joiner", "می‌خواهم"],
  ])("accepts %s", (_label, name) => {
    expect(apiKeyNameProblem(name)).toBeNull();
  });
});
