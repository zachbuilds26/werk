type IconProps = { size?: number; className?: string }

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  }
}

export const Mark = ({ size = 20, className }: IconProps) => (
  <svg {...svgProps(size)} className={className} strokeWidth={2.4}>
    <path d="M3 6 L6.5 18 L12 9 L17.5 18 L21 6" />
  </svg>
)

export const Arrow = ({ size = 18, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
)

export const Presentation = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
    <path d="M8 11v2M12 8.5v4.5M16 11v2" />
  </svg>
)

export const Document = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M9 12h6M9 15.5h6M9 8.5h3" />
  </svg>
)

export const Sheet = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M4 9.5h16M4 14.5h16M10 4v16M15.5 4v16" />
  </svg>
)

export const Calendar = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <rect x="4" y="5" width="16" height="16" rx="1.5" />
    <path d="M4 9.5h16M8.5 3v4M15.5 3v4" />
  </svg>
)

export const List = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <path d="M4 6.5h.01M4 12h.01M4 17.5h.01" />
  </svg>
)

export const Timeline = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <rect x="3" y="4" width="9" height="3.6" rx="1" />
    <rect x="7" y="10.2" width="12" height="3.6" rx="1" />
    <rect x="5" y="16.4" width="8" height="3.6" rx="1" />
  </svg>
)

export const Brief = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <rect x="3" y="7.5" width="18" height="12" rx="1.5" />
    <path d="M8 7.5V6.2A1.4 1.4 0 0 1 9.4 4.8h5.2A1.4 1.4 0 0 1 16 6.2v1.3" />
    <path d="M3 12.5h18" />
  </svg>
)

export const Report = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M9 14l2 2 4-4" />
  </svg>
)

export const Layers = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <path d="M12 3 21 8 12 13 3 8z" />
    <path d="M3 12 12 17 21 12" />
    <path d="M3 16 12 21 21 16" />
  </svg>
)

export const Check = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 20)} className={p.className}>
    <path d="M4 12.5 9 17.5 20 6.5" />
  </svg>
)

export const Download = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 18)} className={p.className}>
    <path d="M12 3v11" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)

export const Redo = (p: IconProps) => (
  <svg {...svgProps(p.size ?? 18)} className={p.className}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 3.3V8h-4.7" />
  </svg>
)
