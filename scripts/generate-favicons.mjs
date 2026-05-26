#!/usr/bin/env node
// Regenerates the favicon, apple-touch icon, PWA icons, and OG image
// from src/app/icon.svg. Run with `node scripts/generate-favicons.mjs`
// whenever the source logo changes.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "src", "app");
const publicDir = path.join(repoRoot, "public");
const sourceSvg = path.join(appDir, "icon.svg");

const BG = { r: 15, g: 25, b: 35, alpha: 1 }; // matches the logo's #0f1923 backdrop

async function renderPng(size, padding = 0) {
  const inner = size - padding * 2;
  const sprite = await sharp(sourceSvg, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BG,
    },
  })
    .composite([{ input: sprite, top: padding, left: padding }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(pngs.length, 4);

  const directory = Buffer.alloc(16 * pngs.length);
  const dataChunks = [];
  let offset = 6 + directory.length;

  pngs.forEach(({ size, buffer }, i) => {
    const d = directory.subarray(i * 16, i * 16 + 16);
    d.writeUInt8(size === 256 ? 0 : size, 0); // width
    d.writeUInt8(size === 256 ? 0 : size, 1); // height
    d.writeUInt8(0, 2); // palette
    d.writeUInt8(0, 3); // reserved
    d.writeUInt16LE(1, 4); // color planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(buffer.length, 8); // bytes
    d.writeUInt32LE(offset, 12); // offset
    dataChunks.push(buffer);
    offset += buffer.length;
  });

  return Buffer.concat([header, directory, ...dataChunks]);
}

async function main() {
  await readFile(sourceSvg); // ensure source exists

  // Files Next.js picks up from app/ via the file convention.
  const appTasks = [
    { name: "apple-icon.png", size: 180, padding: 0 },
  ];
  for (const { name, size, padding } of appTasks) {
    const buffer = await renderPng(size, padding);
    await writeFile(path.join(appDir, name), buffer);
    console.log(`wrote src/app/${name} (${size}x${size}${padding ? `, pad ${padding}` : ""})`);
  }

  // PWA icons referenced from the web app manifest.
  const publicTasks = [
    { name: "icon-192.png", size: 192, padding: 0 },
    { name: "icon-512.png", size: 512, padding: 0 },
    { name: "icon-maskable-512.png", size: 512, padding: 64 },
  ];
  for (const { name, size, padding } of publicTasks) {
    const buffer = await renderPng(size, padding);
    await writeFile(path.join(publicDir, name), buffer);
    console.log(`wrote public/${name} (${size}x${size}${padding ? `, pad ${padding}` : ""})`);
  }

  const icoSizes = [16, 32, 48];
  const icoPngs = await Promise.all(
    icoSizes.map(async (size) => ({ size, buffer: await renderPng(size) }))
  );
  await writeFile(path.join(appDir, "favicon.ico"), buildIco(icoPngs));
  console.log(`wrote src/app/favicon.ico (${icoSizes.join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
