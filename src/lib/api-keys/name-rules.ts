/**
 * What an API key's name may be — one rule for the create schema and the
 * settings form, so the form refuses exactly what the server would.
 *
 * Client-safe: no Node imports.
 *
 * The name is written into audit log lines and shown in the key list. Control
 * characters and line separators could forge a log line; bidi controls and
 * invisible characters could make a name display as something it is not.
 * Format characters are NOT refused as a class: the zero-width joiner and the
 * variation selectors are how ordinary emoji such as "🏳️‍🌈" are built.
 */

export const API_KEY_NAME_MAX_LENGTH = 64;

const FORBIDDEN_CHARACTER =
  /[\p{Cc}\p{Zl}\p{Zp}­؜᠎​‎‏‪-‮⁠-⁯﻿￹-￻]/u;

const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** Why a (trimmed) name cannot be used, or null when it can. */
export function apiKeyNameProblem(name: string): string | null {
  if (name.length === 0) return "Name is required";
  if (name.length > API_KEY_NAME_MAX_LENGTH) {
    return `Name must be ${API_KEY_NAME_MAX_LENGTH} characters or fewer`;
  }
  if (FORBIDDEN_CHARACTER.test(name)) {
    return "Name cannot contain control characters, direction overrides or invisible characters";
  }
  if (!VISIBLE_CHARACTER.test(name)) return "Name must contain a visible character";
  return null;
}
