/** Three compact session rows — the desktop activity bar's cockpit toggle. */
export function CockpitGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 14 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="0.75" y="1.5" width="12.5" height="4" rx="1" />
      <rect x="0.75" y="8" width="12.5" height="4" rx="1" />
      <rect x="0.75" y="14.5" width="12.5" height="4" rx="1" />
      <path d="M3 3.5h6.5M3 10h6.5M3 16.5h6.5" />
    </svg>
  );
}
