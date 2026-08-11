// Hand-drawn line-icon set for the marketing site. One consistent stroke,
// rounded joins, currentColor. Deliberately NOT emoji (a known "AI-built"
// tell) and NOT a heavy icon-font dependency, just a few tidy paths.

const PATHS = {
  notes: (
    <>
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
      <path d="M9 13h6M9 16.5h6M9 9.5h2" />
    </>
  ),
  exam: (
    <>
      <rect x="5" y="5" width="14" height="16" rx="2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M8.5 13l2 2 4.5-5" />
    </>
  ),
  repeat: (
    <>
      <path d="M4 10a7 7 0 0 1 12-3.2L18 9" />
      <path d="M20 14a7 7 0 0 1-12 3.2L6 15" />
      <path d="M18 4.5V9h-4.5" />
      <path d="M6 19.5V15h4.5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 17l8 4 8-4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4L18.5 9.5l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 9.5h16M8 3v4M16 3v4" />
      <path d="M9 14.5l2 2 4-4" />
    </>
  ),
  spark: <path d="M12 3l1.6 7.4L21 12l-7.4 1.6L12 21l-1.6-7.4L3 12l7.4-1.6z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  tag: (
    <>
      <path d="M4 4h7l9 9-7 7-9-9V4z" />
      <circle cx="8" cy="8" r="1.3" />
    </>
  ),
  bolt: <path d="M13 3L5 13.5h5l-1 7.5 8-11.5h-5z" />,
  check: <path d="M5 12.5l4 4 10-11" />,
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.4 2" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l1.5-2h7L18 8h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5h16v11H9l-4 3.5V16H4z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5l5-5" />
      <path d="M10.5 6.5l1.2-1.2a4 4 0 0 1 5.7 5.7L16 12" />
      <path d="M13.5 17.5l-1.2 1.2a4 4 0 0 1-5.7-5.7L8 11.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </>
  ),
  chevron: <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.4 4.4l1.7 1.7M17.9 17.9l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.4 19.6l1.7-1.7M17.9 6.1l1.7-1.7" />
    </>
  ),
  moon: <path d="M20 14.6A8.5 8.5 0 1 1 9.4 4 6.7 6.7 0 0 0 20 14.6z" />,
  chart: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M7 20.5v-6.5M12 20.5V8.5M17 20.5v-9.5" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.6 8.4l-2.3 4.9-4.9 2.3 2.3-4.9z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.6" />
    </>
  ),
  flame: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
  volume: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16.5 8.8a4 4 0 0 1 0 6.4M19 6.3a7.5 7.5 0 0 1 0 11.4" />
    </>
  ),
  cap: (
    <>
      <path d="M12 4L2.5 8.5 12 13l9.5-4.5L12 4z" />
      <path d="M6 10.5V15c0 1.5 2.7 2.7 6 2.7s6-1.2 6-2.7v-4.5" />
      <path d="M21.5 9v4.2" />
    </>
  ),
  folder: <path d="M3.5 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L12 7h6.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7z" />,
  paperclip: <path d="M20 11.5l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.4-8.4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.6 1.6 0 0 1-2.3-2.3l7.7-7.7" />,
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.3" />
      <circle cx="9" cy="17" r="2.3" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 9.5h18M6.5 14.5h4" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.6l1.4 2.7 3-.4.9 2.9 2.7 1.3-1 2.9 1 2.9-2.7 1.3-.9 2.9-3-.4L12 21.4l-1.4-2.7-3 .4-.9-2.9-2.7-1.3 1-2.9-1-2.9 2.7-1.3.9-2.9 3 .4z" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.4L2 20.6h20L12 3.4z" />
      <path d="M12 9.5v4.6M12 17.4h.01" />
    </>
  ),
  gem: (
    <>
      <path d="M6 3h12l3 5-9 13L3 8l3-5z" />
      <path d="M3 8h18M9 3l-1.5 5L12 21M15 3l1.5 5L12 21" />
    </>
  ),
};

export default function Icon({ name, size = 24, stroke = 1.6, className, style }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {d}
    </svg>
  );
}
