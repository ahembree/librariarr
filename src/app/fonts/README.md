# Bundled fonts

The app's three typefaces are served from these files through `next/font/local`
(`src/app/layout.tsx`), so `next build` makes no network request for fonts.

They used to come from `next/font/google`, which downloads Google's stylesheet
during the build. A change in the URLs Google returned for Sora made Turbopack
reject every `@font-face` in it ("next/font/google queries have exactly one
entry"), failing the Docker build while the code was unchanged.

| File | Family | Upstream version | Used as |
|------|--------|------------------|---------|
| `Sora-Variable.woff2` | Sora | 2.000 | `--font-display` (`font-display`) |
| `PlusJakartaSans-Variable.woff2` | Plus Jakarta Sans | 2.071 | `--font-sans` (`font-sans`) |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono | 2.211 | `--font-mono` (`font-mono`) |

Each is the family's variable font (`[wght]` axis) from
[google/fonts](https://github.com/google/fonts) — `ofl/sora/Sora[wght].ttf`,
`ofl/plusjakartasans/PlusJakartaSans[wght].ttf`,
`ofl/jetbrainsmono/JetBrainsMono[wght].ttf` — converted to WOFF2 with every
glyph kept (Latin, Latin Extended, Cyrillic, Greek and Vietnamese, as far as
each family covers them), so non-English titles render in the same face as
before:

```sh
pip install fonttools brotli
python -c "from fontTools.ttLib import TTFont; f = TTFont('Sora[wght].ttf'); f.flavor = 'woff2'; f.save('Sora-Variable.woff2')"
```

All three are licensed under the SIL Open Font License 1.1; the license and
copyright notice for each is in the matching `OFL-*.txt`.
