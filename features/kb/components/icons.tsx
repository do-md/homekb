/**
 * Inline SVG icon set (design handoff: simple geometric shapes, 1–1.8px strokes,
 * no icon font, no external images). All icons inherit `currentColor`.
 */

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

function base({ size = 18, strokeWidth = 1.6, className }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconActivity(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 12h3l3-7 6 14 3-7h3" />
    </svg>
  );
}

export function IconPhoneSignal(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="6" y="4" width="9" height="16" rx="2" />
      <path d="M10 17h1" />
      <path d="M18 7a6.5 6.5 0 0 1 0 5" />
      <path d="M20.5 5a10 10 0 0 1 0 9" />
    </svg>
  );
}

export function IconSliders(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

export function IconDoc(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M10 12h5M10 16h5" />
    </svg>
  );
}

export function IconDocPlus(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}

export function IconSpark(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3l1.8 5.7L19.5 10l-5.7 1.8L12 17.5l-1.8-5.7L4.5 10l5.7-1.3z" />
    </svg>
  );
}

export function IconChevronLeft(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9.5 5.5L16 12l-6.5 6.5" />
    </svg>
  );
}

export function IconArrowRight(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconArrowUp(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4.5 12.5l5 5L19.5 7" />
    </svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M20 11a8 8 0 1 0-1.5 6.5" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function IconCopy(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

export function IconPencil(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
      <path d="M14 7l3 3" />
    </svg>
  );
}

export function IconX(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Loading ring (homekb-spin). Coral by default via currentColor. */
export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`hk-spin inline-block rounded-full border-2 border-current border-t-transparent align-middle ${className}`}
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  );
}

/** Connection dot; color supplied by text-hk-green / text-hk-amber / text-hk-orange on the parent. */
export function StatusDot({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-current ${className}`}
      aria-hidden
    />
  );
}
