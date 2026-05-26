interface LogoProps {
  size?: number;
  className?: string;
}

// next/image would add overhead with no optimisation benefit for an 8KB SVG,
// and the browser cache already has /icon.svg from the favicon link.
/* eslint-disable @next/next/no-img-element */
export function Logo({ size = 24, className }: LogoProps) {
  return (
    <img
      src="/icon.svg"
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    />
  );
}
