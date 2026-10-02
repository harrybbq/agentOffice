// Small inline SVG icons (16px grid, stroke = currentColor). No icon font, no emoji.
import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

type P = { size?: number }

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Svg>
)
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
)
export const IconBan = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.25" />
    <path d="M4.4 4.4l7.2 7.2" />
  </Svg>
)
export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
)
export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M4.5 6.5L6.5 8l-2 1.5M8.5 10h3" />
  </Svg>
)
export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
    <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </Svg>
)
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M1.75 4.5a1.5 1.5 0 011.5-1.5h2.6l1.5 1.75h5.4a1.5 1.5 0 011.5 1.5v5.25a1.5 1.5 0 01-1.5 1.5H3.25a1.5 1.5 0 01-1.5-1.5z" />
  </Svg>
)
export const IconInbox = (p: P) => (
  <Svg {...p}>
    <path d="M2 9l1.6-5.2A1.5 1.5 0 015 2.75h6a1.5 1.5 0 011.4 1.05L14 9v2.75a1.5 1.5 0 01-1.5 1.5h-9a1.5 1.5 0 01-1.5-1.5z" />
    <path d="M2 9h3.25l.75 1.5h4L10.75 9H14" />
  </Svg>
)
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M13.5 2.5l-11 4.2 4.3 1.9 1.9 4.4z" />
    <path d="M13.5 2.5L6.8 8.6" />
  </Svg>
)
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </Svg>
)
export const IconInterrupt = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M6.5 6v4M9.5 6v4" />
  </Svg>
)
export const IconDockRight = (p: P) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M9.5 2.75v10.5" />
  </Svg>
)
export const IconDockBottom = (p: P) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M1.75 9h12.5" />
  </Svg>
)
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </Svg>
)
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />
  </Svg>
)
export const IconFit = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6V3.5a1 1 0 011-1H6M10 2.5h2.5a1 1 0 011 1V6M13.5 10v2.5a1 1 0 01-1 1H10M6 13.5H3.5a1 1 0 01-1-1V10" />
  </Svg>
)
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.25l6 10.5H2z" />
    <path d="M8 6.5v3M8 11.25h.01" />
  </Svg>
)
export const IconMegaphone = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6.5v3h2l5 3v-9l-5 3z" />
    <path d="M12 6.25a2.5 2.5 0 010 3.5" />
  </Svg>
)
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5" />
  </Svg>
)
