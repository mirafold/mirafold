/** The phone workspace toggle's glyph: a panel with its side column — the
 * one drawer that holds both Files and Changes on ≤640px, where two
 * separate desktop rail icons are too crowded for the status bar.
 * Drawn on FilesGlyph's 14×20 artwork box at the same
 * 1.5 stroke so it sits in the bar at the same footprint. */
export function WorkspaceGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 14 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="0.75" y="3.25" width="12.5" height="13.5" rx="1.5" />
      <path d="M5.25 3.25v13.5" />
      <path d="M2.75 6.5h0.75M2.75 9h0.75M2.75 11.5h0.75" strokeLinecap="round" />
    </svg>
  );
}
