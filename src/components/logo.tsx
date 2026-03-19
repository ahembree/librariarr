"use client";

import { useId } from "react";

interface LogoProps {
  size?: number;
  className?: string;
}

export function Logo({ size = 24, className }: LogoProps) {
  const id = useId();
  const gradientId = `logo-grad-${id}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="66"
          y1="44"
          x2="446"
          y2="452"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#818cf8" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      {/* Back book body */}
      <rect
        x="66"
        y="72"
        width="120"
        height="368"
        rx="14"
        fill={`url(#${gradientId})`}
        opacity="0.2"
      />
      {/* Back book spine */}
      <rect
        x="66"
        y="72"
        width="18"
        height="368"
        rx="9"
        fill={`url(#${gradientId})`}
        opacity="0.38"
      />
      {/* Front book body */}
      <rect
        x="146"
        y="44"
        width="124"
        height="424"
        rx="14"
        fill={`url(#${gradientId})`}
        opacity="0.5"
      />
      {/* Front book spine */}
      <rect
        x="146"
        y="44"
        width="18"
        height="424"
        rx="9"
        fill={`url(#${gradientId})`}
        opacity="0.72"
      />
      {/* Play triangle with rounded tip */}
      <path
        d="M286 60 L440 248 Q448 256 440 264 L286 452 Z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}
