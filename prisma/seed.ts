/**
 * Database seed script for generating mock data.
 * Creates a demo user with fictional media libraries across multiple server types.
 * Generates placeholder poster artwork in the image cache.
 *
 * Usage:
 *   pnpm docker:dev:seed     (inside Docker dev container)
 *   pnpm seed                (locally, if DB is accessible)
 *
 * Login with: username "demo", password "demo"
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import type { InputJsonValue } from "../src/generated/prisma/internal/prismaNamespace.js";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// DB client (standalone — can't use @/lib/db outside Next.js)
// ---------------------------------------------------------------------------

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_CACHE_DIR = process.env.IMAGE_CACHE_DIR || "/config/cache/images";
const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo";

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

let ratingKeyCounter = 1000;
function nextRatingKey(): string {
  return String(++ratingKeyCounter);
}

function dedupKeyFor(title: string, year: number | null): string {
  const raw = `${title.toLowerCase().trim()}-${year ?? "unknown"}`;
  return createHash("md5").update(raw).digest("hex");
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function hoursAgo(hours: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d;
}

function fileSizeForMovie(resolution: string, durationMs: number): bigint {
  const hours = durationMs / 3_600_000;
  const gbPerHour: Record<string, number> = {
    "4k": 18, "1080": 7, "720": 3, sd: 1.5,
  };
  const rate = gbPerHour[resolution] ?? 5;
  // Add some variation: +-20%
  const variation = 0.8 + Math.random() * 0.4;
  return BigInt(Math.round(rate * hours * variation * 1_073_741_824));
}

function fileSizeForEpisode(resolution: string, durationMs: number): bigint {
  const hours = durationMs / 3_600_000;
  const gbPerHour: Record<string, number> = {
    "4k": 12, "1080": 5, "720": 2.5, sd: 1,
  };
  const rate = gbPerHour[resolution] ?? 3;
  const variation = 0.8 + Math.random() * 0.4;
  return BigInt(Math.round(rate * hours * variation * 1_073_741_824));
}

function fileSizeForTrack(durationMs: number, codec: string): bigint {
  const seconds = durationMs / 1000;
  const kbps = codec === "flac" ? 1000 : 256;
  return BigInt(Math.round((kbps * seconds) / 8 * 1024));
}

// Seeded pseudo-random for deterministic output
let seed = 42;
function seededRandom(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(seededRandom() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => seededRandom() - 0.5);
  return shuffled.slice(0, n);
}

function randomInt(min: number, max: number): number {
  return Math.floor(seededRandom() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Image cache helpers (mirrors src/lib/image-cache/image-cache.ts logic)
// ---------------------------------------------------------------------------

function normalizeCacheUrl(url: string): string {
  return url.replace(/^(\/library\/metadata\/\d+\/(?:thumb|art))\/\d+$/, "$1");
}

function computeCacheKey(thumbPath: string): string {
  const normalized = normalizeCacheUrl(thumbPath);
  return createHash("sha256").update(normalized).digest("hex");
}

function getCachePath(cacheKey: string): string {
  const shard1 = cacheKey.slice(0, 2);
  const shard2 = cacheKey.slice(2, 4);
  return path.join(IMAGE_CACHE_DIR, shard1, shard2, `${cacheKey}.webp`);
}

// Deterministic color from title
function colorFromTitle(title: string): { r: number; g: number; b: number } {
  const hash = createHash("md5").update(title).digest();
  return {
    r: (hash[0] % 180) + 40, // avoid pure white/black
    g: (hash[1] % 180) + 40,
    b: (hash[2] % 180) + 40,
  };
}

async function generatePlaceholderImage(
  title: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const { r, g, b } = colorFromTitle(title);
  // Darker bottom gradient color
  const r2 = Math.max(0, r - 60);
  const g2 = Math.max(0, g - 60);
  const b2 = Math.max(0, b - 60);

  // Use pure SVG gradient without text — avoids fontconfig dependency in Alpine containers
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgb(${r},${g},${b})" />
        <stop offset="100%" stop-color="rgb(${r2},${g2},${b2})" />
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)" />
  </svg>`;

  return sharp(Buffer.from(svg))
    .resize(width, height)
    .webp({ quality: 80 })
    .toBuffer();
}

async function writePlaceholderImage(
  thumbUrl: string,
  title: string,
  type: "movie" | "series" | "music",
): Promise<void> {
  const cacheKey = computeCacheKey(thumbUrl);
  const cachePath = getCachePath(cacheKey);

  const [width, height] = type === "music" ? [400, 400] : [400, 600];

  const imageBuffer = await generatePlaceholderImage(title, width, height);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, imageBuffer);
}

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

const STUDIOS = [
  "Paramount Pictures", "Warner Bros.", "Universal Pictures", "20th Century Studios",
  "Columbia Pictures", "Lionsgate", "A24", "Focus Features", "New Line Cinema",
  "MGM", "DreamWorks", "Searchlight Pictures", "Blumhouse Productions",
  "Legendary Entertainment", "StudioCanal", "Neon", "IFC Films",
];

const CONTENT_RATINGS = ["G", "PG", "PG-13", "R", "NR", "TV-14", "TV-MA"];

const GENRE_POOLS = {
  movie: [
    "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
    "Drama", "Fantasy", "Horror", "Mystery", "Romance", "Sci-Fi",
    "Thriller", "War", "Western", "Musical", "Biography",
  ],
  series: [
    "Action", "Adventure", "Animation", "Comedy", "Crime", "Drama",
    "Fantasy", "Horror", "Mystery", "Romance", "Sci-Fi", "Thriller",
  ],
  music: [
    "Rock", "Pop", "Jazz", "Classical", "Electronic", "Hip-Hop",
    "R&B", "Country", "Folk", "Metal", "Indie", "Blues",
  ],
};

interface MovieDef {
  title: string;
  year: number;
  resolution: string;
  videoCodec: string;
  dynamicRange: string;
  audioCodec: string;
  audioProfile: string | null;
  audioChannels: number;
  container: string;
  contentRating: string;
  studio: string;
  genres: string[];
  durationMs: number;
  rating: number;
  playCount: number;
  addedDaysAgo: number;
}

// ~50 hardcoded movies with specific characteristics
const BASE_MOVIES: MovieDef[] = [
  // --- 4K Dolby Vision / HDR flagships ---
  { title: "The Iron Vault", year: 2024, resolution: "4k", videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "PG-13", studio: "Paramount Pictures", genres: ["Action", "Adventure"], durationMs: 8_400_000, rating: 8.2, playCount: 5, addedDaysAgo: 14 },
  { title: "Starfall Protocol", year: 2024, resolution: "4k", videoCodec: "hevc", dynamicRange: "HDR10", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "R", studio: "Warner Bros.", genres: ["Sci-Fi", "Thriller"], durationMs: 7_800_000, rating: 7.8, playCount: 3, addedDaysAgo: 21 },
  { title: "Crimson Meridian", year: 2023, resolution: "4k", videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "R", studio: "Universal Pictures", genres: ["Action", "Crime"], durationMs: 9_000_000, rating: 8.5, playCount: 8, addedDaysAgo: 45 },
  { title: "Whispers in the Fog", year: 2024, resolution: "4k", videoCodec: "hevc", dynamicRange: "HDR10", audioCodec: "dts-hd ma", audioProfile: "DTS:X", audioChannels: 8, container: "mkv", contentRating: "PG-13", studio: "A24", genres: ["Horror", "Mystery"], durationMs: 6_900_000, rating: 7.4, playCount: 2, addedDaysAgo: 30 },
  { title: "Apex Horizon", year: 2023, resolution: "4k", videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "PG-13", studio: "Legendary Entertainment", genres: ["Sci-Fi", "Adventure"], durationMs: 8_700_000, rating: 8.0, playCount: 6, addedDaysAgo: 60 },
  { title: "The Glass Labyrinth", year: 2024, resolution: "4k", videoCodec: "av1", dynamicRange: "HDR10+", audioCodec: "eac3", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "R", studio: "A24", genres: ["Drama", "Thriller"], durationMs: 7_200_000, rating: 8.8, playCount: 4, addedDaysAgo: 10 },
  { title: "Neon Requiem", year: 2023, resolution: "4k", videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "R", studio: "Neon", genres: ["Sci-Fi", "Drama"], durationMs: 7_500_000, rating: 7.6, playCount: 1, addedDaysAgo: 90 },
  { title: "Summit Ridge", year: 2024, resolution: "4k", videoCodec: "hevc", dynamicRange: "HDR10", audioCodec: "dts-hd ma", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG", studio: "Focus Features", genres: ["Adventure", "Drama"], durationMs: 7_800_000, rating: 7.2, playCount: 0, addedDaysAgo: 7 },
  { title: "Fractured Light", year: 2022, resolution: "4k", videoCodec: "hevc", dynamicRange: "HDR10", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "Columbia Pictures", genres: ["Fantasy", "Adventure"], durationMs: 8_100_000, rating: 7.0, playCount: 3, addedDaysAgo: 120 },
  { title: "The Velvet Conspiracy", year: 2024, resolution: "4k", videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "R", studio: "Lionsgate", genres: ["Thriller", "Crime"], durationMs: 7_200_000, rating: 7.9, playCount: 2, addedDaysAgo: 18 },
  { title: "Orbit Decay", year: 2023, resolution: "4k", videoCodec: "hevc", dynamicRange: "HDR10+", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "20th Century Studios", genres: ["Sci-Fi", "Action"], durationMs: 7_600_000, rating: 6.8, playCount: 1, addedDaysAgo: 150 },
  { title: "Undertow", year: 2024, resolution: "4k", videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioProfile: "Dolby Atmos", audioChannels: 8, container: "mkv", contentRating: "R", studio: "A24", genres: ["Drama", "Mystery"], durationMs: 6_600_000, rating: 8.3, playCount: 7, addedDaysAgo: 25 },

  // --- 1080p mixed ---
  { title: "Echoes of Tomorrow", year: 2022, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 6, container: "mp4", contentRating: "PG-13", studio: "Universal Pictures", genres: ["Sci-Fi", "Drama"], durationMs: 7_200_000, rating: 7.5, playCount: 12, addedDaysAgo: 200 },
  { title: "The Cartographer's Daughter", year: 2021, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG", studio: "Searchlight Pictures", genres: ["Drama", "Adventure"], durationMs: 6_600_000, rating: 7.8, playCount: 4, addedDaysAgo: 180 },
  { title: "Midnight Crossing", year: 2023, resolution: "1080", videoCodec: "hevc", dynamicRange: "SDR", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "R", studio: "Lionsgate", genres: ["Thriller", "Crime"], durationMs: 6_900_000, rating: 6.9, playCount: 2, addedDaysAgo: 75 },
  { title: "Paper Lanterns", year: 2020, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG", studio: "Focus Features", genres: ["Drama", "Romance"], durationMs: 6_300_000, rating: 7.2, playCount: 6, addedDaysAgo: 240 },
  { title: "Shadow Play", year: 2022, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "Columbia Pictures", genres: ["Action", "Thriller"], durationMs: 7_500_000, rating: 6.5, playCount: 1, addedDaysAgo: 160 },
  { title: "The Wandering Stars", year: 2023, resolution: "1080", videoCodec: "hevc", dynamicRange: "SDR", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "DreamWorks", genres: ["Animation", "Fantasy"], durationMs: 5_700_000, rating: 7.6, playCount: 15, addedDaysAgo: 100 },
  { title: "Hollow Creek", year: 2021, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 6, container: "mp4", contentRating: "R", studio: "Blumhouse Productions", genres: ["Horror", "Thriller"], durationMs: 5_400_000, rating: 6.3, playCount: 0, addedDaysAgo: 210 },
  { title: "The Last Architect", year: 2019, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "MGM", genres: ["Drama", "Biography"], durationMs: 8_400_000, rating: 8.1, playCount: 9, addedDaysAgo: 220 },
  { title: "Burning Shores", year: 2022, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "R", studio: "Lionsgate", genres: ["War", "Drama"], durationMs: 8_100_000, rating: 7.3, playCount: 3, addedDaysAgo: 130 },
  { title: "The Porcelain Key", year: 2023, resolution: "1080", videoCodec: "hevc", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "StudioCanal", genres: ["Mystery", "Drama"], durationMs: 6_600_000, rating: 7.0, playCount: 2, addedDaysAgo: 85 },
  { title: "Copper Sun", year: 2020, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG", studio: "Searchlight Pictures", genres: ["Drama", "Biography"], durationMs: 7_200_000, rating: 7.7, playCount: 5, addedDaysAgo: 190 },
  { title: "The Silver Compass", year: 2021, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "New Line Cinema", genres: ["Fantasy", "Adventure"], durationMs: 7_800_000, rating: 6.8, playCount: 4, addedDaysAgo: 170 },
  { title: "Deadlock", year: 2023, resolution: "1080", videoCodec: "hevc", dynamicRange: "SDR", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "R", studio: "Paramount Pictures", genres: ["Action", "Crime"], durationMs: 6_900_000, rating: 6.4, playCount: 1, addedDaysAgo: 55 },
  { title: "Wildflower", year: 2022, resolution: "1080", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG", studio: "IFC Films", genres: ["Romance", "Drama"], durationMs: 5_700_000, rating: 7.4, playCount: 8, addedDaysAgo: 140 },
  { title: "Ember Coast", year: 2024, resolution: "1080", videoCodec: "hevc", dynamicRange: "SDR", audioCodec: "eac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "Warner Bros.", genres: ["Adventure", "Sci-Fi"], durationMs: 7_200_000, rating: 7.1, playCount: 2, addedDaysAgo: 20 },

  // --- 720p ---
  { title: "The Quiet Arrangement", year: 2018, resolution: "720", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "R", studio: "Lionsgate", genres: ["Thriller", "Drama"], durationMs: 6_600_000, rating: 6.7, playCount: 1, addedDaysAgo: 230 },
  { title: "Once Upon a Vineyard", year: 2017, resolution: "720", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG", studio: "Focus Features", genres: ["Comedy", "Romance"], durationMs: 5_400_000, rating: 6.2, playCount: 3, addedDaysAgo: 240 },
  { title: "Iron Rails", year: 2019, resolution: "720", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "PG-13", studio: "MGM", genres: ["Western", "Adventure"], durationMs: 7_200_000, rating: 6.9, playCount: 0, addedDaysAgo: 200 },
  { title: "Patchwork", year: 2016, resolution: "720", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG-13", studio: "IFC Films", genres: ["Comedy", "Drama"], durationMs: 5_700_000, rating: 6.0, playCount: 0, addedDaysAgo: 240 },
  { title: "The Jade Tiger", year: 2018, resolution: "720", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 6, container: "mkv", contentRating: "R", studio: "StudioCanal", genres: ["Action", "Thriller"], durationMs: 6_300_000, rating: 5.9, playCount: 0, addedDaysAgo: 210 },

  // --- SD ---
  { title: "Farmhouse Tales", year: 2010, resolution: "sd", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "G", studio: "DreamWorks", genres: ["Animation", "Comedy"], durationMs: 5_400_000, rating: 6.5, playCount: 20, addedDaysAgo: 240 },
  { title: "The Dusty Road", year: 2008, resolution: "sd", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "ac3", audioProfile: null, audioChannels: 2, container: "avi", contentRating: "PG", studio: "MGM", genres: ["Drama", "Western"], durationMs: 6_000_000, rating: 5.5, playCount: 0, addedDaysAgo: 240 },
  { title: "Clockwork Garden", year: 2012, resolution: "sd", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG", studio: "IFC Films", genres: ["Fantasy", "Drama"], durationMs: 5_700_000, rating: 6.1, playCount: 1, addedDaysAgo: 240 },
  { title: "Below the Surface", year: 2009, resolution: "sd", videoCodec: "mpeg4", dynamicRange: "SDR", audioCodec: "mp3", audioProfile: null, audioChannels: 2, container: "avi", contentRating: "R", studio: "Lionsgate", genres: ["Horror", "Mystery"], durationMs: 5_400_000, rating: 4.8, playCount: 0, addedDaysAgo: 240 },
  { title: "Summer Letters", year: 2011, resolution: "sd", videoCodec: "h264", dynamicRange: "SDR", audioCodec: "aac", audioProfile: null, audioChannels: 2, container: "mp4", contentRating: "PG", studio: "Searchlight Pictures", genres: ["Romance", "Drama"], durationMs: 6_300_000, rating: 6.8, playCount: 2, addedDaysAgo: 240 },
];

// Adjectives/nouns for generating additional movie titles
const TITLE_ADJECTIVES = [
  "Silent", "Golden", "Forgotten", "Frozen", "Broken", "Eternal", "Hidden",
  "Dark", "Rising", "Fallen", "Crimson", "Distant", "Burning", "Shattered",
  "Hollow", "Vast", "Iron", "Silver", "Midnight", "Fading", "Sacred",
  "Ancient", "Last", "First", "Northern", "Southern", "Deep", "Final",
];

const TITLE_NOUNS = [
  "Kingdom", "Horizon", "Canyon", "River", "Mountain", "Storm", "Garden",
  "Ocean", "Forest", "Bridge", "Tower", "Gate", "Path", "Legacy", "Echo",
  "Shadow", "Crown", "Flame", "Wave", "Stone", "Dream", "Dawn", "Dusk",
  "Edge", "Shore", "Ridge", "Valley", "Peak", "Harbor", "Compass",
];

function generateMovieTitle(): string {
  const adj = pick(TITLE_ADJECTIVES);
  const noun = pick(TITLE_NOUNS);
  return `The ${adj} ${noun}`;
}

function generateMovieDef(): MovieDef {
  const resolutions = ["4k", "4k", "1080", "1080", "1080", "1080", "720", "720", "sd"];
  const resolution = pick(resolutions);

  const codecMap: Record<string, string[]> = {
    "4k": ["hevc", "hevc", "av1"],
    "1080": ["h264", "h264", "hevc"],
    "720": ["h264"],
    sd: ["h264", "mpeg4"],
  };
  const videoCodec = pick(codecMap[resolution]);

  const drMap: Record<string, string[]> = {
    "4k": ["Dolby Vision", "Dolby Vision", "HDR10", "HDR10", "HDR10+", "SDR"],
    "1080": ["SDR", "SDR", "SDR", "HDR10"],
    "720": ["SDR"],
    sd: ["SDR"],
  };
  const dynamicRange = pick(drMap[resolution]);

  const isDV = dynamicRange === "Dolby Vision";
  const audioCodec = isDV ? pick(["truehd", "eac3"]) : pick(["aac", "ac3", "eac3", "dts-hd ma"]);
  const audioProfile = audioCodec === "truehd" ? "Dolby Atmos" : (audioCodec === "dts-hd ma" && seededRandom() > 0.5 ? "DTS:X" : null);
  const audioChannels = audioCodec === "aac" && seededRandom() > 0.5 ? 2 : (audioProfile ? 8 : 6);

  const year = randomInt(2015, 2024);
  const durationMs = randomInt(5_400_000, 9_600_000);

  return {
    title: generateMovieTitle(),
    year,
    resolution,
    videoCodec,
    dynamicRange,
    audioCodec,
    audioProfile,
    audioChannels,
    container: videoCodec === "mpeg4" ? "avi" : (seededRandom() > 0.3 ? "mkv" : "mp4"),
    contentRating: pick(CONTENT_RATINGS),
    studio: pick(STUDIOS),
    genres: pickN(GENRE_POOLS.movie, randomInt(1, 3)),
    durationMs,
    rating: Math.round((seededRandom() * 4 + 5) * 10) / 10, // 5.0 - 9.0
    playCount: randomInt(0, 15),
    addedDaysAgo: randomInt(5, 240),
  };
}

// ---------------------------------------------------------------------------
// Series definitions
// ---------------------------------------------------------------------------

interface SeriesDef {
  title: string;
  seasons: number;
  episodesPerSeason: number;
  resolution: string;
  videoCodec: string;
  genres: string[];
  contentRating: string;
  year: number;
}

const BASE_SERIES: SeriesDef[] = [
  { title: "The Last Frontier", seasons: 4, episodesPerSeason: 10, resolution: "4k", videoCodec: "hevc", genres: ["Sci-Fi", "Drama"], contentRating: "TV-MA", year: 2020 },
  { title: "Night Shift", seasons: 3, episodesPerSeason: 8, resolution: "1080", videoCodec: "h264", genres: ["Crime", "Thriller"], contentRating: "TV-MA", year: 2021 },
  { title: "Harbor Lights", seasons: 3, episodesPerSeason: 10, resolution: "1080", videoCodec: "h264", genres: ["Drama", "Romance"], contentRating: "TV-14", year: 2019 },
  { title: "Binary Code", seasons: 2, episodesPerSeason: 8, resolution: "4k", videoCodec: "hevc", genres: ["Sci-Fi", "Thriller"], contentRating: "TV-MA", year: 2023 },
  { title: "Copper Hills", seasons: 5, episodesPerSeason: 6, resolution: "1080", videoCodec: "h264", genres: ["Western", "Drama"], contentRating: "TV-14", year: 2018 },
  { title: "The Greenhouse", seasons: 2, episodesPerSeason: 10, resolution: "1080", videoCodec: "hevc", genres: ["Drama", "Mystery"], contentRating: "TV-14", year: 2022 },
  { title: "Pulse", seasons: 3, episodesPerSeason: 8, resolution: "4k", videoCodec: "hevc", genres: ["Action", "Drama"], contentRating: "TV-MA", year: 2021 },
  { title: "The Moth Effect", seasons: 1, episodesPerSeason: 6, resolution: "4k", videoCodec: "hevc", genres: ["Horror", "Sci-Fi"], contentRating: "TV-MA", year: 2024 },
  { title: "Overture", seasons: 4, episodesPerSeason: 8, resolution: "1080", videoCodec: "h264", genres: ["Drama", "Musical"], contentRating: "TV-14", year: 2019 },
  { title: "Sandcastle", seasons: 2, episodesPerSeason: 10, resolution: "1080", videoCodec: "h264", genres: ["Comedy", "Drama"], contentRating: "TV-14", year: 2022 },
  { title: "Threadbare", seasons: 3, episodesPerSeason: 6, resolution: "720", videoCodec: "h264", genres: ["Drama", "Crime"], contentRating: "TV-MA", year: 2017 },
  { title: "Parallax", seasons: 2, episodesPerSeason: 8, resolution: "4k", videoCodec: "hevc", genres: ["Sci-Fi", "Mystery"], contentRating: "TV-MA", year: 2023 },
  { title: "Marble Arch", seasons: 3, episodesPerSeason: 10, resolution: "1080", videoCodec: "h264", genres: ["Drama", "Crime"], contentRating: "TV-14", year: 2020 },
  { title: "Canopy", seasons: 1, episodesPerSeason: 8, resolution: "4k", videoCodec: "hevc", genres: ["Adventure", "Drama"], contentRating: "TV-14", year: 2024 },
  { title: "Static", seasons: 2, episodesPerSeason: 6, resolution: "1080", videoCodec: "hevc", genres: ["Horror", "Thriller"], contentRating: "TV-MA", year: 2022 },
  { title: "Waypoint", seasons: 4, episodesPerSeason: 8, resolution: "1080", videoCodec: "h264", genres: ["Action", "Adventure"], contentRating: "TV-14", year: 2019 },
  { title: "Afterglow", seasons: 2, episodesPerSeason: 10, resolution: "1080", videoCodec: "h264", genres: ["Romance", "Drama"], contentRating: "TV-14", year: 2021 },
  { title: "Iron Tide", seasons: 3, episodesPerSeason: 6, resolution: "4k", videoCodec: "hevc", genres: ["War", "Drama"], contentRating: "TV-MA", year: 2020 },
  { title: "Kaleidoscope", seasons: 1, episodesPerSeason: 8, resolution: "4k", videoCodec: "hevc", genres: ["Mystery", "Thriller"], contentRating: "TV-MA", year: 2024 },
  { title: "Driftwood", seasons: 2, episodesPerSeason: 10, resolution: "720", videoCodec: "h264", genres: ["Drama", "Comedy"], contentRating: "TV-14", year: 2018 },
];

const SERIES_TITLE_WORDS = [
  "Signal", "Outpost", "Fracture", "Circuit", "Meridian", "Equinox", "Cascade",
  "Eclipse", "Threshold", "Nexus", "Prism", "Ember", "Vanguard", "Tempest",
  "Crucible", "Genesis", "Vortex", "Sentinel", "Nomad", "Zenith", "Catalyst",
  "Reverie", "Labyrinth", "Phantom", "Alchemy", "Dominion", "Aegis", "Solstice",
  "Paragon", "Obsidian", "Azure", "Pinnacle", "Bastion", "Relic", "Tundra",
  "Apex", "Nova", "Oasis", "Citadel", "Mirage",
];

function generateSeriesDef(): SeriesDef {
  const resolution = pick(["4k", "1080", "1080", "1080", "720"]);
  const videoCodec = resolution === "4k" ? "hevc" : pick(["h264", "h264", "hevc"]);
  return {
    title: pick(SERIES_TITLE_WORDS),
    seasons: randomInt(1, 5),
    episodesPerSeason: pick([6, 8, 10, 12]),
    resolution,
    videoCodec,
    genres: pickN(GENRE_POOLS.series, randomInt(1, 3)),
    contentRating: pick(["TV-14", "TV-14", "TV-MA"]),
    year: randomInt(2016, 2024),
  };
}

// ---------------------------------------------------------------------------
// Music definitions
// ---------------------------------------------------------------------------

interface ArtistDef {
  name: string;
  albums: { title: string; trackCount: number; year: number; codec: string }[];
  genres: string[];
}

const BASE_ARTISTS: ArtistDef[] = [
  { name: "Midnight Cascade", albums: [{ title: "Tidal Patterns", trackCount: 12, year: 2023, codec: "flac" }, { title: "Deep Current", trackCount: 10, year: 2021, codec: "flac" }], genres: ["Electronic", "Indie"] },
  { name: "The Silver Collective", albums: [{ title: "First Light", trackCount: 11, year: 2022, codec: "flac" }, { title: "Afterburn", trackCount: 9, year: 2020, codec: "flac" }], genres: ["Rock", "Indie"] },
  { name: "Velvet Observatory", albums: [{ title: "Stardust Memoirs", trackCount: 14, year: 2024, codec: "flac" }], genres: ["Jazz", "Electronic"] },
  { name: "Iron Petal", albums: [{ title: "Rust & Bloom", trackCount: 10, year: 2023, codec: "flac" }, { title: "Thorns", trackCount: 8, year: 2021, codec: "flac" }], genres: ["Metal", "Rock"] },
  { name: "The Lantern Bearers", albums: [{ title: "Folklore Sessions", trackCount: 12, year: 2022, codec: "flac" }], genres: ["Folk", "Indie"] },
  { name: "Axiom", albums: [{ title: "Proof of Concept", trackCount: 10, year: 2024, codec: "flac" }, { title: "Theorem", trackCount: 11, year: 2022, codec: "flac" }], genres: ["Electronic", "Pop"] },
  { name: "Sable Moon", albums: [{ title: "Nocturnes", trackCount: 9, year: 2023, codec: "flac" }], genres: ["Classical", "Jazz"] },
  { name: "The Riviera Sound", albums: [{ title: "Coastal Drive", trackCount: 12, year: 2023, codec: "aac" }, { title: "Sun Kissed", trackCount: 10, year: 2021, codec: "aac" }], genres: ["Pop", "R&B"] },
  { name: "Gravel & Grace", albums: [{ title: "Back Roads", trackCount: 11, year: 2022, codec: "flac" }], genres: ["Country", "Folk"] },
  { name: "Pulse Engine", albums: [{ title: "Overdrive", trackCount: 10, year: 2024, codec: "flac" }, { title: "Redline", trackCount: 9, year: 2022, codec: "flac" }], genres: ["Electronic", "Hip-Hop"] },
  { name: "Cerulean", albums: [{ title: "Blue Hour", trackCount: 13, year: 2023, codec: "flac" }], genres: ["Blues", "Jazz"] },
  { name: "Glass Animals Orchestra", albums: [{ title: "Symbiosis", trackCount: 8, year: 2024, codec: "flac" }], genres: ["Classical", "Electronic"] },
  { name: "The Driftwood Ensemble", albums: [{ title: "Watermark", trackCount: 10, year: 2021, codec: "aac" }, { title: "Saltwater", trackCount: 11, year: 2019, codec: "aac" }], genres: ["Indie", "Folk"] },
  { name: "Neon Caravan", albums: [{ title: "Desert Frequencies", trackCount: 12, year: 2023, codec: "flac" }], genres: ["Electronic", "Rock"] },
  { name: "Ivory Tower", albums: [{ title: "Ascent", trackCount: 10, year: 2024, codec: "flac" }, { title: "Foundation", trackCount: 9, year: 2022, codec: "flac" }], genres: ["Metal", "Rock"] },
];

const ARTIST_NAME_PARTS = [
  "Crystal", "Shadow", "Copper", "Velvet", "Iron", "Golden", "Silver", "Electric",
  "Phantom", "Neon", "Ember", "Frost", "Thunder", "Lunar", "Solar", "Cosmic",
];

const ARTIST_NAME_SUFFIXES = [
  "Wave", "Drive", "Sound", "Pulse", "Echo", "Signal", "Current", "Circuit",
  "Tide", "Spark", "Glow", "Shift", "Phase", "Drift", "Flow", "Arc",
];

const ALBUM_WORDS = [
  "Fragments", "Horizons", "Echoes", "Reflections", "Currents", "Seasons",
  "Passages", "Wavelengths", "Frequencies", "Resonance", "Patterns", "Journeys",
  "Chapters", "Moments", "Transitions", "Dimensions", "Perspectives", "Textures",
];

function generateArtistDef(): ArtistDef {
  const name = `${pick(ARTIST_NAME_PARTS)} ${pick(ARTIST_NAME_SUFFIXES)}`;
  const albumCount = randomInt(1, 3);
  const albums = [];
  for (let i = 0; i < albumCount; i++) {
    albums.push({
      title: pick(ALBUM_WORDS),
      trackCount: randomInt(8, 14),
      year: randomInt(2018, 2024),
      codec: seededRandom() > 0.3 ? "flac" : "aac",
    });
  }
  return { name, albums, genres: pickN(GENRE_POOLS.music, randomInt(1, 2)) };
}

// ---------------------------------------------------------------------------
// Log entries
// ---------------------------------------------------------------------------

interface LogDef {
  level: "INFO" | "WARN" | "ERROR";
  category: "BACKEND" | "API" | "DB";
  message: string;
  hoursAgo: number;
}

const LOG_ENTRIES: LogDef[] = [
  { level: "INFO", category: "BACKEND", message: "Sync completed for Atlas — 247 items processed", hoursAgo: 2 },
  { level: "INFO", category: "BACKEND", message: "Sync completed for Nebula — 89 items processed", hoursAgo: 2 },
  { level: "INFO", category: "BACKEND", message: "Sync completed for Cosmos — 53 items processed", hoursAgo: 2 },
  { level: "INFO", category: "BACKEND", message: "Lifecycle detection completed: 14 matches across 3 rule sets", hoursAgo: 6 },
  { level: "INFO", category: "BACKEND", message: "Scheduled backup completed successfully", hoursAgo: 24 },
  { level: "INFO", category: "BACKEND", message: "Image cache cleanup: removed 23 expired entries", hoursAgo: 48 },
  { level: "WARN", category: "BACKEND", message: "Media server Cosmos responded slowly (3240ms)", hoursAgo: 8 },
  { level: "WARN", category: "BACKEND", message: "Dedup merge: 3 items had conflicting metadata across servers", hoursAgo: 12 },
  { level: "WARN", category: "API", message: "Rate limit approached for auth endpoint (8/10 attempts)", hoursAgo: 36 },
  { level: "ERROR", category: "BACKEND", message: "Failed to connect to Cosmos: ECONNREFUSED 192.168.1.50:8920", hoursAgo: 72 },
  { level: "ERROR", category: "API", message: "Sync job failed for Nebula: timeout after 30s", hoursAgo: 96 },
  { level: "INFO", category: "BACKEND", message: "Lifecycle execution: 2 actions completed successfully", hoursAgo: 30 },
  { level: "INFO", category: "BACKEND", message: "Plex collection synced: 'Low Quality Movies' — 8 items", hoursAgo: 6 },
  { level: "INFO", category: "DB", message: "Database migration completed: 0003_add_watch_history", hoursAgo: 168 },
  { level: "WARN", category: "BACKEND", message: "Transcode session detected: user exceeded quality threshold", hoursAgo: 18 },
];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function main() {
  console.log("Starting seed...\n");

  // --- Cleanup ---
  console.log("Cleaning up existing demo data...");
  const existingUser = await prisma.user.findFirst({ where: { localUsername: DEMO_USERNAME } });
  if (existingUser) {
    // Delete rule matches, lifecycle actions first (they reference both user and media items)
    await prisma.ruleMatch.deleteMany({
      where: { ruleSet: { userId: existingUser.id } },
    });
    await prisma.lifecycleAction.deleteMany({ where: { userId: existingUser.id } });
    await prisma.user.delete({ where: { id: existingUser.id } });
    console.log("  Deleted existing demo user and cascaded data.");
  }
  await prisma.logEntry.deleteMany({ where: { source: "seed" } });
  await prisma.systemConfig.deleteMany({ where: { id: "singleton" } });
  console.log("  Cleanup complete.\n");

  // --- SystemConfig ---
  await prisma.systemConfig.create({
    data: { id: "singleton", plexClientId: "seed-demo-client", setupCompleted: true },
  });

  // --- User ---
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      localUsername: DEMO_USERNAME,
      passwordHash,
      username: "Demo User",
      email: "demo@example.com",
    },
  });
  console.log(`Created user: ${user.username} (login: ${DEMO_USERNAME} / ${DEMO_PASSWORD})`);

  // --- AppSettings ---
  await prisma.appSettings.create({
    data: {
      userId: user.id,
      localAuthEnabled: true,
      accentColor: "default",
      syncSchedule: "EVERY_6H",
      dedupStats: true,
      transcodeManagerEnabled: true,
      transcodeManagerMessage: "Your stream is being transcoded. Please switch to a direct-play compatible format.",
      transcodeManagerDelay: 60,
      transcodeManagerCriteria: {
        anyTranscoding: false,
        videoTranscoding: true,
        audioTranscoding: false,
        fourKTranscoding: true,
        remoteTranscoding: false,
      },
      transcodeManagerExcludedUsers: ["demo"],
      maintenanceExcludedUsers: ["demo"],
    },
  });

  // --- Media Servers ---
  const servers = await Promise.all([
    prisma.mediaServer.create({
      data: {
        userId: user.id, type: "PLEX", name: "Atlas",
        url: "https://atlas.plex.direct:32400",
        accessToken: "seed-atlas-token", machineId: "seed-atlas-001",
      },
    }),
    prisma.mediaServer.create({
      data: {
        userId: user.id, type: "JELLYFIN", name: "Nebula",
        url: "https://nebula.local:8096",
        accessToken: "seed-nebula-token", machineId: "seed-nebula-001",
      },
    }),
    prisma.mediaServer.create({
      data: {
        userId: user.id, type: "EMBY", name: "Cosmos",
        url: "https://cosmos.local:8920",
        accessToken: "seed-cosmos-token", machineId: "seed-cosmos-001",
      },
    }),
  ]);
  const [atlas, nebula, cosmos] = servers;
  console.log(`Created ${servers.length} media servers: Atlas (Plex), Nebula (Jellyfin), Cosmos (Emby)`);

  // --- Arr / Seerr Instances ---
  const [radarr, radarr4k, sonarr, sonarr4k, lidarr] = await Promise.all([
    prisma.radarrInstance.create({
      data: {
        userId: user.id, name: "Radarr", url: "http://radarr.local:7878",
        apiKey: "seed-radarr-api-key", enabled: true,
      },
    }),
    prisma.radarrInstance.create({
      data: {
        userId: user.id, name: "Radarr 4K", url: "http://radarr-4k.local:7878",
        apiKey: "seed-radarr-4k-api-key", enabled: true,
      },
    }),
    prisma.sonarrInstance.create({
      data: {
        userId: user.id, name: "Sonarr", url: "http://sonarr.local:8989",
        apiKey: "seed-sonarr-api-key", enabled: true,
      },
    }),
    prisma.sonarrInstance.create({
      data: {
        userId: user.id, name: "Sonarr 4K", url: "http://sonarr-4k.local:8989",
        apiKey: "seed-sonarr-4k-api-key", enabled: true,
      },
    }),
    prisma.lidarrInstance.create({
      data: {
        userId: user.id, name: "Lidarr", url: "http://lidarr.local:8686",
        apiKey: "seed-lidarr-api-key", enabled: true,
      },
    }),
    prisma.seerrInstance.create({
      data: {
        userId: user.id, name: "Overseerr", url: "http://overseerr.local:5055",
        apiKey: "seed-seerr-api-key", enabled: true,
      },
    }),
  ]);
  console.log("Created 6 integration instances: Radarr, Radarr 4K, Sonarr, Sonarr 4K, Lidarr, Overseerr");

  // --- Libraries (3 per server) ---
  const libraryDefs = [
    { serverId: atlas.id, key: "1", title: "Movies", type: "MOVIE" as const },
    { serverId: atlas.id, key: "2", title: "TV Shows", type: "SERIES" as const },
    { serverId: atlas.id, key: "3", title: "Music", type: "MUSIC" as const },
    { serverId: nebula.id, key: "1", title: "Movies", type: "MOVIE" as const },
    { serverId: nebula.id, key: "2", title: "TV Shows", type: "SERIES" as const },
    { serverId: nebula.id, key: "3", title: "Music", type: "MUSIC" as const },
    { serverId: cosmos.id, key: "1", title: "Movies", type: "MOVIE" as const },
    { serverId: cosmos.id, key: "2", title: "TV Shows", type: "SERIES" as const },
    { serverId: cosmos.id, key: "3", title: "Music", type: "MUSIC" as const },
  ];

  const libraries: Record<string, { id: string; type: string }> = {};
  for (const lib of libraryDefs) {
    const created = await prisma.library.create({
      data: {
        mediaServerId: lib.serverId,
        key: lib.key,
        title: lib.title,
        type: lib.type,
        enabled: true,
        lastSyncedAt: daysAgo(1),
      },
    });
    // Key: "serverName-type" e.g. "atlas-MOVIE"
    const serverName = lib.serverId === atlas.id ? "atlas" : lib.serverId === nebula.id ? "nebula" : "cosmos";
    libraries[`${serverName}-${lib.type}`] = { id: created.id, type: lib.type };
  }
  console.log(`Created ${libraryDefs.length} libraries (3 per server)\n`);

  // --- Generate all movie definitions ---
  const allMovieDefs = [...BASE_MOVIES];
  const generatedTitles = new Set(BASE_MOVIES.map((m) => m.title));
  while (allMovieDefs.length < 250) {
    const def = generateMovieDef();
    if (!generatedTitles.has(def.title)) {
      generatedTitles.add(def.title);
      allMovieDefs.push(def);
    }
  }

  // Distribute movies: all 250 on Atlas (canonical), subsets also on Nebula/Cosmos
  const atlasMovies = allMovieDefs; // all 250
  const nebulaMovies = allMovieDefs.slice(0, 70); // 70 items, overlap with Atlas
  const cosmosMovies = allMovieDefs.slice(0, 50); // 50 items, overlap with Atlas

  // Track all created items for artwork generation and watch history
  const allCreatedItems: { id: string; thumbUrl: string; title: string; type: "movie" | "series" | "music" }[] = [];
  // Track all items with their server ID for watch history (across all servers)
  const allItemsForHistory: { id: string; serverId: string; type: "movie" | "series" | "music" }[] = [];

  // Map library IDs to server IDs
  const libraryToServer: Record<string, string> = {};
  for (const [key, lib] of Object.entries(libraries)) {
    const serverName = key.split("-")[0];
    libraryToServer[lib.id] = serverName === "atlas" ? atlas.id : serverName === "nebula" ? nebula.id : cosmos.id;
  }

  // Helper to create movies for a specific library
  async function createMovies(
    movieDefs: MovieDef[],
    libraryId: string,
    isCanonical: boolean,
  ) {
    const items = [];
    for (const def of movieDefs) {
      const rk = nextRatingKey();
      const thumbUrl = `/library/metadata/${rk}/thumb`;
      const artUrl = `/library/metadata/${rk}/art`;
      const dk = dedupKeyFor(def.title, def.year);

      const videoWidth = def.resolution === "4k" ? 3840 : def.resolution === "1080" ? 1920 : def.resolution === "720" ? 1280 : 720;
      const videoHeight = def.resolution === "4k" ? 2160 : def.resolution === "1080" ? 1080 : def.resolution === "720" ? 720 : 480;
      const videoBitrate = def.resolution === "4k" ? randomInt(15000, 40000) : def.resolution === "1080" ? randomInt(5000, 15000) : def.resolution === "720" ? randomInt(2000, 5000) : randomInt(800, 2000);

      const item = await prisma.mediaItem.create({
        data: {
          libraryId,
          ratingKey: rk,
          title: def.title,
          titleSort: def.title.replace(/^The /, ""),
          year: def.year,
          type: "MOVIE",
          summary: `A ${def.genres.join("/").toLowerCase()} film set in ${def.year}.`,
          thumbUrl,
          artUrl,
          resolution: def.resolution,
          videoWidth,
          videoHeight,
          videoCodec: def.videoCodec,
          videoProfile: def.videoCodec === "hevc" ? "Main 10" : "High",
          videoFrameRate: pick(["24p", "23.976p", "25p"]),
          videoBitDepth: def.dynamicRange !== "SDR" ? 10 : 8,
          videoBitrate,
          videoColorPrimaries: def.dynamicRange !== "SDR" ? "bt2020" : "bt709",
          videoColorRange: def.dynamicRange !== "SDR" ? "tv" : "tv",
          videoRangeType: def.dynamicRange === "Dolby Vision" ? "DOVI" : def.dynamicRange === "HDR10+" ? "HDR10Plus" : def.dynamicRange === "HDR10" ? "HDR" : "SDR",
          aspectRatio: pick(["2.39:1", "1.85:1", "2.35:1", "1.78:1"]),
          scanType: "progressive",
          audioCodec: def.audioCodec,
          audioChannels: def.audioChannels,
          audioProfile: def.audioProfile,
          audioBitrate: def.audioCodec === "truehd" ? randomInt(4000, 7000) : def.audioCodec === "eac3" ? randomInt(640, 1024) : randomInt(128, 448),
          audioSamplingRate: 48000,
          container: def.container,
          dynamicRange: def.dynamicRange,
          optimizedForStreaming: def.container === "mp4",
          fileSize: fileSizeForMovie(def.resolution, def.durationMs),
          filePath: `/media/movies/${def.title} (${def.year})/${def.title} (${def.year}).${def.container}`,
          duration: def.durationMs,
          contentRating: def.contentRating,
          rating: def.rating,
          audienceRating: Math.round((def.rating + (seededRandom() - 0.5) * 2) * 10) / 10,
          studio: def.studio,
          genres: def.genres,
          directors: [pick(["Alex Morgan", "Jordan Hayes", "Casey Rivera", "Quinn Taylor", "Robin Chen", "Avery Brooks", "Sam Nakamura", "Drew Sullivan"])],
          // Non-canonical copies get lower/zero play counts (realistic: users typically watch on one server)
          playCount: isCanonical ? def.playCount : (def.playCount > 0 ? randomInt(0, Math.max(1, Math.floor(def.playCount / 4))) : 0),
          lastPlayedAt: (isCanonical ? def.playCount > 0 : seededRandom() > 0.7 && def.playCount > 0) ? daysAgo(randomInt(1, def.addedDaysAgo)) : null,
          addedAt: daysAgo(def.addedDaysAgo),
          dedupKey: dk,
          dedupCanonical: isCanonical,
          originallyAvailableAt: new Date(def.year, randomInt(0, 11), randomInt(1, 28)),
        },
      });
      items.push(item);
      allCreatedItems.push({ id: item.id, thumbUrl, title: def.title, type: "movie" });
      allItemsForHistory.push({ id: item.id, serverId: libraryToServer[libraryId], type: "movie" });
    }
    return items;
  }

  console.log("Creating movies...");
  const atlasMovieItems = await createMovies(atlasMovies, libraries["atlas-MOVIE"].id, true);
  await createMovies(nebulaMovies, libraries["nebula-MOVIE"].id, false);
  await createMovies(cosmosMovies, libraries["cosmos-MOVIE"].id, false);
  console.log(`  Created ${allMovieDefs.length} movie definitions across 3 servers (with overlap)\n`);

  // --- Media Streams for ~50 higher-quality movies ---
  console.log("Creating media streams...");
  let streamCount = 0;
  const moviesForStreams = atlasMovieItems.filter((m) => {
    const def = atlasMovies.find((d) => d.title === m.title);
    return def && (def.resolution === "4k" || (def.resolution === "1080" && def.videoCodec === "hevc"));
  }).slice(0, 50);

  for (const movie of moviesForStreams) {
    const def = atlasMovies.find((d) => d.title === movie.title)!;

    // Video stream
    await prisma.mediaStream.create({
      data: {
        mediaItemId: movie.id,
        streamType: 1,
        index: 0,
        codec: def.videoCodec,
        profile: def.videoCodec === "hevc" ? "Main 10" : "High",
        bitrate: movie.videoBitrate,
        isDefault: true,
        displayTitle: `${def.resolution === "4k" ? "4K" : "1080p"} (${def.videoCodec.toUpperCase()})`,
        extendedDisplayTitle: `${def.resolution === "4k" ? "4K" : "1080p"} (${def.videoCodec.toUpperCase()} ${def.dynamicRange})`,
        width: movie.videoWidth,
        height: movie.videoHeight,
        frameRate: 23.976,
        scanType: "progressive",
        colorPrimaries: def.dynamicRange !== "SDR" ? "bt2020" : "bt709",
        colorRange: "tv",
        chromaSubsampling: def.dynamicRange !== "SDR" ? "4:2:0" : "4:2:0",
        bitDepth: def.dynamicRange !== "SDR" ? 10 : 8,
        videoRangeType: movie.videoRangeType,
      },
    });
    streamCount++;

    // Primary audio stream
    await prisma.mediaStream.create({
      data: {
        mediaItemId: movie.id,
        streamType: 2,
        index: 1,
        codec: def.audioCodec,
        profile: def.audioProfile,
        bitrate: movie.audioBitrate,
        isDefault: true,
        displayTitle: `English (${def.audioProfile ?? def.audioCodec.toUpperCase()} ${def.audioChannels === 8 ? "7.1" : def.audioChannels === 6 ? "5.1" : "Stereo"})`,
        language: "English",
        languageCode: "eng",
        channels: def.audioChannels,
        samplingRate: 48000,
        audioChannelLayout: def.audioChannels === 8 ? "7.1" : def.audioChannels === 6 ? "5.1(side)" : "stereo",
      },
    });
    streamCount++;

    // Secondary audio (stereo compatibility track) for high-end movies
    if (def.audioProfile) {
      await prisma.mediaStream.create({
        data: {
          mediaItemId: movie.id,
          streamType: 2,
          index: 2,
          codec: "aac",
          bitrate: 256,
          isDefault: false,
          displayTitle: "English (AAC Stereo)",
          language: "English",
          languageCode: "eng",
          channels: 2,
          samplingRate: 48000,
          audioChannelLayout: "stereo",
        },
      });
      streamCount++;
    }

    // Subtitle streams
    const subtitleLangs = [
      { lang: "English", code: "eng" },
      ...(seededRandom() > 0.5 ? [{ lang: "Spanish", code: "spa" }] : []),
    ];
    for (let si = 0; si < subtitleLangs.length; si++) {
      await prisma.mediaStream.create({
        data: {
          mediaItemId: movie.id,
          streamType: 3,
          index: (def.audioProfile ? 3 : 2) + si,
          codec: pick(["srt", "ass", "subrip"]),
          isDefault: si === 0,
          displayTitle: `${subtitleLangs[si].lang} (SRT)`,
          language: subtitleLangs[si].lang,
          languageCode: subtitleLangs[si].code,
          forced: false,
        },
      });
      streamCount++;
    }
  }
  console.log(`  Created ${streamCount} media streams for ${moviesForStreams.length} movies\n`);

  // --- Generate series ---
  console.log("Creating TV series...");
  const allSeriesDefs = [...BASE_SERIES];
  const usedSeriesTitles = new Set(BASE_SERIES.map((s) => s.title));
  while (allSeriesDefs.length < 60) {
    const def = generateSeriesDef();
    if (!usedSeriesTitles.has(def.title)) {
      usedSeriesTitles.add(def.title);
      allSeriesDefs.push(def);
    }
  }

  // Distribute: all on Atlas, ~25 also on Nebula
  const nebulaSeriesOverlap = allSeriesDefs.slice(0, 25);

  let totalEpisodes = 0;

  async function createSeriesEpisodes(
    seriesDef: SeriesDef,
    libraryId: string,
    isCanonical: boolean,
  ) {
    const seriesRk = nextRatingKey();
    const seriesThumbUrl = `/library/metadata/${seriesRk}/thumb`;
    allCreatedItems.push({ id: "", thumbUrl: seriesThumbUrl, title: seriesDef.title, type: "series" });

    for (let s = 1; s <= seriesDef.seasons; s++) {
      const seasonRk = nextRatingKey();
      for (let e = 1; e <= seriesDef.episodesPerSeason; e++) {
        const epRk = nextRatingKey();
        const epTitle = `Episode ${e}`;
        const durationMs = randomInt(2_400_000, 3_600_000); // 40-60 min
        const dk = dedupKeyFor(`${seriesDef.title}-s${s}e${e}`, seriesDef.year);
        const thumbUrl = `/library/metadata/${epRk}/thumb`;

        const item = await prisma.mediaItem.create({
          data: {
            libraryId,
            ratingKey: epRk,
            parentRatingKey: seasonRk.toString(),
            grandparentRatingKey: seriesRk.toString(),
            title: epTitle,
            parentTitle: seriesDef.title,
            seasonNumber: s,
            episodeNumber: e,
            year: seriesDef.year + s - 1,
            type: "SERIES",
            summary: `Season ${s}, Episode ${e} of ${seriesDef.title}.`,
            thumbUrl,
            parentThumbUrl: seriesThumbUrl,
            resolution: seriesDef.resolution,
            videoWidth: seriesDef.resolution === "4k" ? 3840 : seriesDef.resolution === "1080" ? 1920 : 1280,
            videoHeight: seriesDef.resolution === "4k" ? 2160 : seriesDef.resolution === "1080" ? 1080 : 720,
            videoCodec: seriesDef.videoCodec,
            videoProfile: seriesDef.videoCodec === "hevc" ? "Main 10" : "High",
            videoBitDepth: seriesDef.resolution === "4k" ? 10 : 8,
            videoBitrate: seriesDef.resolution === "4k" ? randomInt(8000, 20000) : randomInt(3000, 8000),
            audioCodec: seriesDef.resolution === "4k" ? pick(["eac3", "truehd"]) : pick(["aac", "ac3", "eac3"]),
            audioChannels: seriesDef.resolution === "4k" ? pick([6, 8]) : pick([2, 6]),
            container: "mkv",
            dynamicRange: seriesDef.resolution === "4k" ? pick(["HDR10", "Dolby Vision"]) : "SDR",
            fileSize: fileSizeForEpisode(seriesDef.resolution, durationMs),
            filePath: `/media/tv/${seriesDef.title}/Season ${String(s).padStart(2, "0")}/${seriesDef.title} - S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}.mkv`,
            duration: durationMs,
            contentRating: seriesDef.contentRating,
            genres: seriesDef.genres,
            // First 10 series get higher play counts for meaningful "Top Series" stats
            // Non-canonical copies get zero plays (users typically watch on primary server)
            playCount: !isCanonical ? 0 :
              seriesDef === allSeriesDefs[0] ? randomInt(5, 15) :
              allSeriesDefs.indexOf(seriesDef) < 10 ? randomInt(2, 8) : randomInt(0, 3),
            lastPlayedAt: isCanonical && seededRandom() > 0.3 ? daysAgo(randomInt(1, 60)) : null,
            addedAt: daysAgo(randomInt(10, 200)),
            originallyAvailableAt: new Date(seriesDef.year + s - 1, randomInt(0, 11), randomInt(1, 28)),
            dedupKey: dk,
            dedupCanonical: isCanonical,
          },
        });
        totalEpisodes++;
        // Only track series thumb once per series, episode thumbs for artwork
        allCreatedItems.push({ id: item.id, thumbUrl, title: `${seriesDef.title} S${s}E${e}`, type: "series" });
        allItemsForHistory.push({ id: item.id, serverId: libraryToServer[libraryId], type: "series" });
      }
    }
  }

  for (const def of allSeriesDefs) {
    await createSeriesEpisodes(def, libraries["atlas-SERIES"].id, true);
  }
  for (const def of nebulaSeriesOverlap) {
    await createSeriesEpisodes(def, libraries["nebula-SERIES"].id, false);
  }
  console.log(`  Created ${allSeriesDefs.length} series (${totalEpisodes} episodes total, ${nebulaSeriesOverlap.length} duplicated on Nebula)\n`);

  // --- Generate music ---
  console.log("Creating music...");
  const allArtistDefs = [...BASE_ARTISTS];
  const usedArtistNames = new Set(BASE_ARTISTS.map((a) => a.name));
  while (allArtistDefs.length < 50) {
    const def = generateArtistDef();
    if (!usedArtistNames.has(def.name)) {
      usedArtistNames.add(def.name);
      allArtistDefs.push(def);
    }
  }

  let totalTracks = 0;

  // Distribute: all on Atlas, ~20 also on Nebula, ~10 on Cosmos
  const nebulaArtistOverlap = allArtistDefs.slice(0, 20);
  const cosmosArtistOverlap = allArtistDefs.slice(0, 10);

  async function createArtistTracks(
    artist: ArtistDef,
    libraryId: string,
    isCanonical: boolean,
  ) {
    const artistRk = nextRatingKey();
    const artistThumbUrl = `/library/metadata/${artistRk}/thumb`;
    allCreatedItems.push({ id: "", thumbUrl: artistThumbUrl, title: artist.name, type: "music" });

    for (const album of artist.albums) {
      const albumRk = nextRatingKey();
      for (let t = 1; t <= album.trackCount; t++) {
        const trackRk = nextRatingKey();
        const durationMs = randomInt(180_000, 360_000); // 3-6 min
        const dk = dedupKeyFor(`${artist.name}-${album.title}-${t}`, album.year);
        const thumbUrl = `/library/metadata/${albumRk}/thumb`;

        const track = await prisma.mediaItem.create({
          data: {
            libraryId,
            ratingKey: trackRk,
            parentRatingKey: albumRk.toString(),
            grandparentRatingKey: artistRk.toString(),
            title: `Track ${t}`,
            parentTitle: artist.name,
            albumTitle: album.title,
            year: album.year,
            type: "MUSIC",
            thumbUrl,
            parentThumbUrl: artistThumbUrl,
            audioCodec: album.codec,
            audioChannels: 2,
            audioBitrate: album.codec === "flac" ? 1411 : 256,
            audioSamplingRate: album.codec === "flac" ? 44100 : 48000,
            container: album.codec === "flac" ? "flac" : "m4a",
            fileSize: fileSizeForTrack(durationMs, album.codec),
            filePath: `/media/music/${artist.name}/${album.title}/${String(t).padStart(2, "0")} - Track ${t}.${album.codec}`,
            duration: durationMs,
            genres: artist.genres,
            playCount: isCanonical ? randomInt(0, 30) : 0,
            lastPlayedAt: isCanonical && seededRandom() > 0.4 ? daysAgo(randomInt(1, 90)) : null,
            addedAt: daysAgo(randomInt(10, 200)),
            dedupKey: dk,
            dedupCanonical: isCanonical,
          },
        });
        totalTracks++;
        allItemsForHistory.push({ id: track.id, serverId: libraryToServer[libraryId], type: "music" });
      }
    }
  }

  for (const artist of allArtistDefs) {
    await createArtistTracks(artist, libraries["atlas-MUSIC"].id, true);
  }
  for (const artist of nebulaArtistOverlap) {
    await createArtistTracks(artist, libraries["nebula-MUSIC"].id, false);
  }
  for (const artist of cosmosArtistOverlap) {
    await createArtistTracks(artist, libraries["cosmos-MUSIC"].id, false);
  }
  console.log(`  Created ${allArtistDefs.length} artists (${totalTracks} tracks total)\n`);

  // --- Rule Sets ---
  console.log("Creating lifecycle rule sets...");
  const ruleSet1 = await prisma.ruleSet.create({
    data: {
      userId: user.id,
      name: "Low Quality Movies — Delete via Radarr",
      type: "MOVIE",
      rules: [
        {
          id: "g1",
          condition: "AND" as const,
          rules: [
            { id: "r1", field: "resolution", operator: "equals", value: "sd", condition: "AND" as const },
          ],
          groups: [],
        },
      ],
      enabled: true,
      actionEnabled: true,
      actionType: "delete",
      actionDelayDays: 14,
      arrInstanceId: radarr.id,
      addImportExclusion: true,
      addArrTags: ["low-quality"],
      serverIds: [atlas.id],
    },
  });

  const ruleSet2 = await prisma.ruleSet.create({
    data: {
      userId: user.id,
      name: "Unwatched Old Movies — Unmonitor in Radarr",
      type: "MOVIE",
      rules: [
        {
          id: "g1",
          condition: "AND" as const,
          rules: [
            { id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" as const },
            { id: "r2", field: "addedAt", operator: "notInLastDays", value: "180", condition: "AND" as const },
          ],
          groups: [],
        },
      ],
      enabled: true,
      actionEnabled: true,
      actionType: "unmonitor",
      actionDelayDays: 30,
      arrInstanceId: radarr.id,
      addArrTags: ["unwatched-old"],
      removeArrTags: ["keep"],
      serverIds: [atlas.id],
    },
  });

  await prisma.ruleSet.create({
    data: {
      userId: user.id,
      name: "Low Bitrate Series — Upgrade via Sonarr",
      type: "SERIES",
      rules: [
        {
          id: "g1",
          condition: "AND" as const,
          rules: [
            { id: "r1", field: "videoBitrate", operator: "lessThan", value: "2000", condition: "AND" as const },
          ],
          groups: [],
        },
      ],
      enabled: true,
      actionEnabled: true,
      actionType: "searchAndUpgrade",
      actionDelayDays: 7,
      arrInstanceId: sonarr.id,
      seriesScope: true,
      addArrTags: ["low-bitrate"],
      serverIds: [atlas.id],
    },
  });

  await prisma.ruleSet.create({
    data: {
      userId: user.id,
      name: "4K Movies Not in Radarr 4K",
      type: "MOVIE",
      rules: [
        {
          id: "g1",
          condition: "AND" as const,
          rules: [
            { id: "r1", field: "resolution", operator: "equals", value: "4k", condition: "AND" as const },
            { id: "r2", field: "foundInArr", operator: "equals", value: "false", condition: "AND" as const },
          ],
          groups: [],
        },
      ],
      enabled: true,
      actionEnabled: false,
      actionDelayDays: 7,
      arrInstanceId: radarr4k.id,
      collectionEnabled: true,
      collectionName: "4K Untracked",
      serverIds: [atlas.id],
    },
  });

  await prisma.ruleSet.create({
    data: {
      userId: user.id,
      name: "Ended Series — Unmonitor in Sonarr",
      type: "SERIES",
      rules: [
        {
          id: "g1",
          condition: "AND" as const,
          rules: [
            { id: "r1", field: "arrEnded", operator: "equals", value: "true", condition: "AND" as const },
            { id: "r2", field: "lastPlayedAt", operator: "notInLastDays", value: "365", condition: "AND" as const },
          ],
          groups: [],
        },
      ],
      enabled: true,
      actionEnabled: true,
      actionType: "unmonitor",
      actionDelayDays: 14,
      arrInstanceId: sonarr4k.id,
      addArrTags: ["ended-unwatched"],
      discordNotifyOnAction: true,
      discordNotifyOnMatch: true,
      serverIds: [atlas.id, nebula.id],
    },
  });

  await prisma.ruleSet.create({
    data: {
      userId: user.id,
      name: "Unmonitored Music — Clean Up Lidarr",
      type: "MUSIC",
      rules: [
        {
          id: "g1",
          condition: "AND" as const,
          rules: [
            { id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" as const },
            { id: "r2", field: "addedAt", operator: "notInLastDays", value: "90", condition: "AND" as const },
          ],
          groups: [],
        },
      ],
      enabled: true,
      actionEnabled: true,
      actionType: "delete",
      actionDelayDays: 21,
      arrInstanceId: lidarr.id,
      addImportExclusion: true,
      serverIds: [atlas.id],
    },
  });
  console.log("  Created 6 rule sets\n");

  // --- Rule Matches (link qualifying items) ---
  console.log("Creating rule matches...");
  let matchCount = 0;

  // Helper: build a full itemData snapshot from a Prisma MediaItem record
  // (mirrors what detect-matches.ts stores via jsonSafe(item))
  function buildItemData(
    movie: typeof atlasMovieItems[0],
    matchedCriteria: Array<{ ruleId: string; field: string; operator: string; value: string; negate: boolean; actualValue?: string }>,
  ): InputJsonValue {
    return {
      id: movie.id,
      libraryId: movie.libraryId,
      ratingKey: movie.ratingKey,
      parentRatingKey: movie.parentRatingKey,
      grandparentRatingKey: movie.grandparentRatingKey,
      title: movie.title,
      titleSort: movie.titleSort,
      year: movie.year,
      type: movie.type,
      summary: movie.summary,
      thumbUrl: movie.thumbUrl,
      artUrl: movie.artUrl,
      parentTitle: movie.parentTitle,
      seasonNumber: movie.seasonNumber,
      episodeNumber: movie.episodeNumber,
      contentRating: movie.contentRating,
      rating: movie.rating,
      audienceRating: movie.audienceRating,
      studio: movie.studio,
      genres: movie.genres,
      resolution: movie.resolution,
      videoCodec: movie.videoCodec,
      videoProfile: movie.videoProfile,
      videoBitDepth: movie.videoBitDepth,
      videoBitrate: movie.videoBitrate,
      dynamicRange: movie.dynamicRange,
      audioCodec: movie.audioCodec,
      audioChannels: movie.audioChannels,
      audioProfile: movie.audioProfile,
      container: movie.container,
      fileSize: movie.fileSize?.toString() ?? null,
      duration: movie.duration,
      playCount: movie.playCount,
      lastPlayedAt: movie.lastPlayedAt?.toISOString() ?? null,
      addedAt: movie.addedAt?.toISOString() ?? null,
      dedupKey: movie.dedupKey,
      dedupCanonical: movie.dedupCanonical,
      matchedCriteria,
      actualValues: Object.fromEntries(
        matchedCriteria
          .filter((c) => c.actualValue != null)
          .map((c) => [c.field, c.actualValue!]),
      ),
    };
  }

  // Match SD movies to ruleSet1
  const sdMovies = atlasMovieItems.filter((m) => {
    const def = atlasMovies.find((d) => d.title === m.title);
    return def?.resolution === "sd";
  });
  for (const movie of sdMovies) {
    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet1.id,
        mediaItemId: movie.id,
        itemData: buildItemData(movie, [
          { ruleId: "r1", field: "resolution", operator: "equals", value: "sd", negate: false, actualValue: movie.resolution ?? "sd" },
        ]),
      },
    });
    matchCount++;
  }

  // Match unwatched old movies to ruleSet2
  const unwatchedOld = atlasMovieItems.filter((m) => {
    const def = atlasMovies.find((d) => d.title === m.title);
    return def && def.playCount === 0 && def.addedDaysAgo > 180;
  });
  for (const movie of unwatchedOld.slice(0, 10)) {
    const def = atlasMovies.find((d) => d.title === movie.title)!;
    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet2.id,
        mediaItemId: movie.id,
        itemData: buildItemData(movie, [
          { ruleId: "r1", field: "playCount", operator: "equals", value: "0", negate: false, actualValue: "0" },
          { ruleId: "r2", field: "addedAt", operator: "notInLastDays", value: "180", negate: false, actualValue: `${def.addedDaysAgo} days ago` },
        ]),
      },
    });
    matchCount++;
  }
  console.log(`  Created ${matchCount} rule matches\n`);

  // --- Lifecycle Actions (PENDING) ---
  // Create pending actions for items matched by rule sets that have actionEnabled
  console.log("Creating pending lifecycle actions...");
  let actionCount = 0;

  // Pending deletes for SD movies (ruleSet1)
  for (const movie of sdMovies.slice(0, 3)) {
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: movie.id,
        mediaItemTitle: movie.title,
        ruleSetId: ruleSet1.id,
        ruleSetName: "Low Quality Movies — Delete via Radarr",
        ruleSetType: "MOVIE",
        actionType: "delete",
        status: "PENDING",
        scheduledFor: daysAgo(-7), // 7 days from now
        arrInstanceId: radarr.id,
        addImportExclusion: true,
        addArrTags: ["low-quality"],
      },
    });
    actionCount++;
  }

  // Pending unmonitors for unwatched old movies (ruleSet2)
  for (const movie of unwatchedOld.slice(0, 3)) {
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: movie.id,
        mediaItemTitle: movie.title,
        ruleSetId: ruleSet2.id,
        ruleSetName: "Unwatched Old Movies — Unmonitor in Radarr",
        ruleSetType: "MOVIE",
        actionType: "unmonitor",
        status: "PENDING",
        scheduledFor: daysAgo(-14), // 14 days from now
        arrInstanceId: radarr.id,
        addArrTags: ["unwatched-old"],
        removeArrTags: ["keep"],
      },
    });
    actionCount++;
  }

  // A few completed actions for history
  for (const movie of atlasMovieItems.slice(0, 3)) {
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: movie.id,
        mediaItemTitle: movie.title,
        ruleSetId: ruleSet1.id,
        ruleSetName: "Low Quality Movies — Delete via Radarr",
        ruleSetType: "MOVIE",
        actionType: "delete",
        status: "COMPLETED",
        scheduledFor: daysAgo(14),
        executedAt: daysAgo(14),
        arrInstanceId: radarr.id,
      },
    });
    actionCount++;
  }

  // One failed action
  await prisma.lifecycleAction.create({
    data: {
      userId: user.id,
      mediaItemId: atlasMovieItems[10].id,
      mediaItemTitle: atlasMovieItems[10].title,
      ruleSetId: ruleSet2.id,
      ruleSetName: "Unwatched Old Movies — Unmonitor in Radarr",
      ruleSetType: "MOVIE",
      actionType: "unmonitor",
      status: "FAILED",
      scheduledFor: daysAgo(7),
      executedAt: daysAgo(7),
      error: "Radarr API returned 404: Movie not found in Radarr library",
      arrInstanceId: radarr.id,
    },
  });
  actionCount++;
  console.log(`  Created ${actionCount} lifecycle actions (pending, completed, failed)\n`);

  // --- External IDs (TMDB, TVDB, IMDB, MusicBrainz) ---
  console.log("Creating external IDs...");
  let externalIdCount = 0;

  // Movies get TMDB + IMDB IDs
  let tmdbCounter = 100000;
  let imdbCounter = 1000000;
  for (const movie of atlasMovieItems) {
    await prisma.mediaItemExternalId.createMany({
      data: [
        { mediaItemId: movie.id, source: "TMDB", externalId: String(tmdbCounter++) },
        { mediaItemId: movie.id, source: "IMDB", externalId: `tt${String(imdbCounter++).padStart(7, "0")}` },
      ],
    });
    externalIdCount += 2;
  }

  // Series episodes get TVDB IDs (all episodes of a series share a TVDB series ID pattern)
  // Query all canonical series episodes
  const seriesEpisodes = await prisma.mediaItem.findMany({
    where: {
      type: "SERIES",
      dedupCanonical: true,
      library: { mediaServer: { userId: user.id } },
    },
    select: { id: true, parentTitle: true },
    orderBy: { parentTitle: "asc" },
  });

  let tvdbEpCounter = 5000000;
  for (const ep of seriesEpisodes) {
    await prisma.mediaItemExternalId.createMany({
      data: [
        { mediaItemId: ep.id, source: "TVDB", externalId: String(tvdbEpCounter++) },
      ],
    });
    externalIdCount++;
  }

  // Music tracks get MusicBrainz IDs
  const musicTracks = await prisma.mediaItem.findMany({
    where: {
      type: "MUSIC",
      dedupCanonical: true,
      library: { mediaServer: { userId: user.id } },
    },
    select: { id: true },
  });

  let mbCounter = 0;
  for (const track of musicTracks) {
    // Generate a fake UUID-like MusicBrainz ID
    const mbId = `${String(mbCounter++).padStart(8, "0")}-0000-4000-a000-000000000000`;
    await prisma.mediaItemExternalId.create({
      data: { mediaItemId: track.id, source: "MUSICBRAINZ", externalId: mbId },
    });
    externalIdCount++;
  }
  console.log(`  Created ${externalIdCount} external IDs\n`);

  // --- Saved Queries ---
  console.log("Creating saved queries...");
  await prisma.savedQuery.createMany({
    data: [
      {
        userId: user.id,
        name: "4K Dolby Vision Movies",
        query: { resolution: "4k", dynamicRange: "Dolby Vision" },
      },
      {
        userId: user.id,
        name: "Unwatched Movies (180+ days)",
        query: { playCount: "0", addedAtConditions: "notInLastDays:180" },
      },
      {
        userId: user.id,
        name: "HEVC Content",
        query: { videoCodec: "hevc" },
      },
    ],
  });
  console.log("  Created 3 saved queries\n");

  // --- Log Entries ---
  console.log("Creating log entries...");
  for (const log of LOG_ENTRIES) {
    await prisma.logEntry.create({
      data: {
        level: log.level,
        category: log.category,
        source: "seed",
        message: log.message,
        createdAt: hoursAgo(log.hoursAgo),
      },
    });
  }
  console.log(`  Created ${LOG_ENTRIES.length} log entries\n`);

  // --- Watch History ---
  // Correlated with actual playCount: only items with playCount > 0 get history,
  // and each item gets up to playCount records (capped to keep volume reasonable)
  console.log("Creating watch history...");
  const USERNAMES = ["demo", "alice", "bob", "charlie"];
  const DEVICES = ["Living Room TV", "Bedroom TV", "Office PC", "iPad", "iPhone", "Android Phone", "MacBook", "Desktop"];
  const PLATFORMS = ["Roku", "Apple TV", "Chrome", "Safari", "Android", "iOS", "Windows", "macOS"];

  // Query all items with playCount > 0 to build correlated watch history
  const watchedItems = await prisma.mediaItem.findMany({
    where: {
      playCount: { gt: 0 },
      library: { mediaServer: { userId: user.id } },
    },
    select: { id: true, playCount: true, lastPlayedAt: true, addedAt: true, library: { select: { mediaServerId: true } } },
  });

  const watchHistoryData: Array<{
    mediaItemId: string;
    mediaServerId: string;
    serverUsername: string;
    watchedAt: Date;
    deviceName: string;
    platform: string;
  }> = [];

  for (const item of watchedItems) {
    if (!item.library.mediaServerId) continue;
    // Generate history records proportional to playCount (cap at playCount itself)
    const recordCount = item.playCount;
    const baseDate = item.lastPlayedAt ?? item.addedAt ?? daysAgo(30);
    for (let r = 0; r < recordCount; r++) {
      // Spread watch dates: most recent play near lastPlayedAt, older plays further back
      const daysBack = r * randomInt(5, 30);
      const watchDate = new Date(baseDate.getTime() - daysBack * 86_400_000);
      watchHistoryData.push({
        mediaItemId: item.id,
        mediaServerId: item.library.mediaServerId,
        serverUsername: pick(USERNAMES),
        watchedAt: watchDate,
        deviceName: pick(DEVICES),
        platform: pick(PLATFORMS),
      });
    }
  }

  // Batch insert
  const WH_BATCH = 100;
  let historyCount = 0;
  for (let i = 0; i < watchHistoryData.length; i += WH_BATCH) {
    const batch = watchHistoryData.slice(i, i + WH_BATCH);
    await prisma.watchHistory.createMany({ data: batch });
    historyCount += batch.length;
  }
  console.log(`  Created ${historyCount} watch history records (correlated with ${watchedItems.length} played items)\n`);

  // --- Lifecycle Exceptions ---
  console.log("Creating lifecycle exceptions...");
  // Pick ~10 random Atlas movies to exclude from lifecycle processing
  const exceptionItems = atlasMovieItems
    .sort(() => seededRandom() - 0.5)
    .slice(0, 10);
  for (const item of exceptionItems) {
    await prisma.lifecycleException.create({
      data: {
        userId: user.id,
        mediaItemId: item.id,
        reason: pick([
          "Keep permanently — user favorite",
          "Needed for upcoming movie night",
          "Currently being re-watched",
          "Part of curated collection",
          "Sentimental value",
          null,
        ]),
      },
    });
  }
  console.log(`  Created ${exceptionItems.length} lifecycle exceptions\n`);

  // --- Blackout Schedules (Stream Manager) ---
  console.log("Creating blackout schedules...");
  await prisma.blackoutSchedule.create({
    data: {
      userId: user.id,
      name: "Weekday School Hours",
      enabled: true,
      scheduleType: "recurring",
      daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
      startTime: "08:00",
      endTime: "15:00",
      action: "block_new_only",
      message: "Streaming is restricted during school hours.",
      delay: 30,
      excludedUsers: ["demo"],
    },
  });
  await prisma.blackoutSchedule.create({
    data: {
      userId: user.id,
      name: "Late Night Quiet Hours",
      enabled: true,
      scheduleType: "recurring",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6], // Every day
      startTime: "23:00",
      endTime: "06:00",
      action: "warn_then_terminate",
      message: "Streams will be terminated during quiet hours. Please save your progress.",
      delay: 60,
      excludedUsers: [],
    },
  });
  await prisma.blackoutSchedule.create({
    data: {
      userId: user.id,
      name: "Server Maintenance Window",
      enabled: false,
      scheduleType: "one_time",
      startDate: daysAgo(-7), // 7 days from now
      endDate: daysAgo(-7),
      startTime: "02:00",
      endTime: "06:00",
      action: "terminate_immediate",
      message: "Server maintenance in progress. All streams will be terminated.",
      delay: 0,
      excludedUsers: [],
    },
  });
  console.log("  Created 3 blackout schedules\n");

  // --- Preroll Presets & Schedules ---
  console.log("Creating preroll presets and schedules...");
  const prerollPresets = await Promise.all([
    prisma.prerollPreset.create({
      data: {
        userId: user.id,
        name: "Default Intro",
        path: "/media/prerolls/default-intro.mp4",
      },
    }),
    prisma.prerollPreset.create({
      data: {
        userId: user.id,
        name: "Holiday Special",
        path: "/media/prerolls/holiday-special.mp4",
      },
    }),
    prisma.prerollPreset.create({
      data: {
        userId: user.id,
        name: "Summer Vibes",
        path: "/media/prerolls/summer-vibes.mp4",
      },
    }),
    prisma.prerollPreset.create({
      data: {
        userId: user.id,
        name: "Spooky Season",
        path: "/media/prerolls/spooky-season.mp4",
      },
    }),
    prisma.prerollPreset.create({
      data: {
        userId: user.id,
        name: "Movie Night",
        path: "/media/prerolls/movie-night.mp4",
      },
    }),
  ]);

  await prisma.prerollSchedule.create({
    data: {
      userId: user.id,
      name: "Default — Always On",
      enabled: true,
      prerollPath: prerollPresets[0].path,
      scheduleType: "recurring",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "00:00",
      endTime: "23:59",
      priority: 0,
    },
  });
  await prisma.prerollSchedule.create({
    data: {
      userId: user.id,
      name: "Holiday Season",
      enabled: true,
      prerollPath: prerollPresets[1].path,
      scheduleType: "seasonal",
      startDate: new Date(2026, 11, 1), // Dec 1
      endDate: new Date(2027, 0, 2), // Jan 2
      priority: 10,
    },
  });
  await prisma.prerollSchedule.create({
    data: {
      userId: user.id,
      name: "Summer",
      enabled: true,
      prerollPath: prerollPresets[2].path,
      scheduleType: "seasonal",
      startDate: new Date(2026, 5, 1), // Jun 1
      endDate: new Date(2026, 8, 1), // Sep 1
      priority: 5,
    },
  });
  await prisma.prerollSchedule.create({
    data: {
      userId: user.id,
      name: "Halloween",
      enabled: true,
      prerollPath: prerollPresets[3].path,
      scheduleType: "seasonal",
      startDate: new Date(2026, 9, 1), // Oct 1
      endDate: new Date(2026, 10, 1), // Nov 1
      priority: 10,
    },
  });
  await prisma.prerollSchedule.create({
    data: {
      userId: user.id,
      name: "Friday Movie Night",
      enabled: true,
      prerollPath: prerollPresets[4].path,
      scheduleType: "recurring",
      daysOfWeek: [5], // Friday
      startTime: "18:00",
      endTime: "23:59",
      priority: 8,
    },
  });
  console.log(`  Created ${prerollPresets.length} preroll presets and 5 schedules\n`);

  // --- Placeholder Artwork ---
  console.log("Generating placeholder artwork...");
  // Deduplicate by thumbUrl to avoid regenerating for the same URL
  const uniqueThumbUrls = new Map<string, { title: string; type: "movie" | "series" | "music" }>();
  for (const item of allCreatedItems) {
    if (!uniqueThumbUrls.has(item.thumbUrl)) {
      uniqueThumbUrls.set(item.thumbUrl, { title: item.title, type: item.type });
    }
  }

  const entries = [...uniqueThumbUrls.entries()];
  const BATCH_SIZE = 50;
  let artworkCount = 0;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(([thumbUrl, { title, type }]) =>
        writePlaceholderImage(thumbUrl, title, type),
      ),
    );
    artworkCount += batch.length;
    if (artworkCount % 200 === 0 || artworkCount === entries.length) {
      console.log(`  Generated ${artworkCount}/${entries.length} images...`);
    }
  }
  console.log(`  Generated ${artworkCount} placeholder images\n`);

  // --- Summary ---
  console.log("=".repeat(50));
  console.log("Seed complete!");
  console.log(`  User: ${DEMO_USERNAME} / ${DEMO_PASSWORD}`);
  console.log(`  Servers: Atlas (Plex), Nebula (Jellyfin), Cosmos (Emby)`);
  console.log(`  Movies: ${allMovieDefs.length} unique titles`);
  console.log(`  Series: ${allSeriesDefs.length} shows (${totalEpisodes} episodes)`);
  console.log(`  Music: ${allArtistDefs.length} artists (${totalTracks} tracks)`);
  console.log(`  Integrations: Radarr x2, Sonarr x2, Lidarr, Overseerr`);
  console.log(`  Rule Sets: 6 (${matchCount} matches)`);
  console.log(`  Lifecycle Actions: ${actionCount}`);
  console.log(`  Lifecycle Exceptions: ${exceptionItems.length}`);
  console.log(`  External IDs: ${externalIdCount}`);
  console.log(`  Saved Queries: 3`);
  console.log(`  Blackout Schedules: 3`);
  console.log(`  Preroll Presets: ${prerollPresets.length} (5 schedules)`);
  console.log(`  Log Entries: ${LOG_ENTRIES.length}`);
  console.log(`  Watch History: ${historyCount}`);
  console.log(`  Placeholder Images: ${artworkCount}`);
  console.log("=".repeat(50));
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
