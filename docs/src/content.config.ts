import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // The <title> and og:title, when the on-page heading is too terse to
        // say what the page is about ("Plex" → "Plex Integration"). Read by
        // src/route-data.ts; the H1 stays `title`.
        seoTitle: z.string().max(70).optional(),
      }),
    }),
  }),
};
