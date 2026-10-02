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
export const IconPower = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v5" />
    <path d="M4.6 4.6a4.8 4.8 0 1 0 6.8 0" />
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
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" />
  </Svg>
)
export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M2.25 4.25a1.5 1.5 0 011.5-1.5h8.5a1.5 1.5 0 011.5 1.5v5.5a1.5 1.5 0 01-1.5 1.5H7l-3 2.5v-2.5h-.25a1.5 1.5 0 01-1.5-1.5z" />
  </Svg>
)
export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M4 2.5h5l3 3v7a1 1 0 01-1 1H4a1 1 0 01-1-1v-9a1 1 0 011-1z" />
    <path d="M9 2.5v3h3" />
  </Svg>
)
export const IconPencil = (p: P) => (
  <Svg {...p}>
    <path d="M2.75 13.25l.6-2.9 7.4-7.4a1.3 1.3 0 011.85 0l.45.45a1.3 1.3 0 010 1.85l-7.4 7.4z" />
    <path d="M9.6 4.1l2.3 2.3" />
  </Svg>
)
export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c1.7 1.6 2.5 3.4 2.5 5.5S9.7 11.9 8 13.5C6.3 11.9 5.5 10.1 5.5 8S6.3 4.1 8 2.5z" />
  </Svg>
)
export const IconWrench = (p: P) => (
  <Svg {...p}>
    <path d="M10.2 2.6a3.3 3.3 0 00-3.4 4.5L2.7 11.2a1.5 1.5 0 002.1 2.1l4.1-4.1a3.3 3.3 0 004.5-3.4l-2 2-1.6-.4-.4-1.6z" />
  </Svg>
)
export const IconArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Svg>
)
export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="5.75" r="2.25" />
    <path d="M1.75 13c.3-2.2 1.9-3.5 4.25-3.5s3.95 1.3 4.25 3.5M10.5 3.7a2.25 2.25 0 010 4.1M12 9.8c1.3.5 2.1 1.6 2.3 3.2" />
  </Svg>
)
export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.25v3.5M8 5.2h.01" />
  </Svg>
)
export const IconSpark = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.25l1.35 3.9 3.9 1.35-3.9 1.35L8 12.75 6.65 8.85 2.75 7.5l3.9-1.35z" />
    <path d="M12.5 11.5v2M11.5 12.5h2" />
  </Svg>
)
export const IconChecklist = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4.2l1.1 1.1 2-2.3M2.5 9.2l1.1 1.1 2-2.3M8 4.5h5.5M8 9.5h5.5M2.75 13.25h.01M8 13.25h5.5" />
  </Svg>
)
export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.25l4.75 1.7v3.6c0 2.9-1.9 5-4.75 6.2-2.85-1.2-4.75-3.3-4.75-6.2v-3.6z" />
  </Svg>
)
export const IconLogin = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 2.75h2.25a1.5 1.5 0 011.5 1.5v7.5a1.5 1.5 0 01-1.5 1.5H9.5M2.5 8h7M7 5.25L9.75 8 7 10.75" />
  </Svg>
)
export const IconBoard = (p: P) => (
  <Svg {...p}>
    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.25" />
    <path d="M5 6h2.5v2.5H5zM10 5.75h1.25M10 8h1.25M5 10.75h6.25" />
  </Svg>
)
export const IconOverlap = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="8" r="3.75" />
    <circle cx="10" cy="8" r="3.75" />
  </Svg>
)
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.25 4.5V3.25a.75.75 0 01.75-.75h2a.75.75 0 01.75.75V4.5M4.25 4.5l.5 8a1 1 0 001 .95h4.5a1 1 0 001-.95l.5-8M6.75 7v4M9.25 7v4" />
  </Svg>
)
export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M3.25 8h9.5" />
  </Svg>
)
export const IconArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Svg>
)
