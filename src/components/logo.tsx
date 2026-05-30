import iconAsset from "@/app/icon.svg";

interface LogoProps {
  size?: number;
  className?: string;
}

// Source of truth lives at src/app/icon.svg (also Next.js's favicon source).
// Asset imports in Next.js give a content-hashed URL served from
// /_next/static/media/ with immutable caching, so the icon is free after the
// first load. Static SVG imports return a StaticImageData-like object with
// a `src` field; the `typeof` guard tolerates Next.js versions that return a
// plain URL string.
// eslint-disable: next/image adds no benefit for an 8 KB SVG.
const ICON_SRC: string =
  typeof iconAsset === "string"
    ? iconAsset
    : (iconAsset as { src: string }).src;

/* eslint-disable @next/next/no-img-element */
export function Logo({ size = 24, className }: LogoProps) {
  return (
    <img
      src={ICON_SRC}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    />
  );
}
