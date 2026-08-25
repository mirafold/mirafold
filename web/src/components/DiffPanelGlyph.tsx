/** The Changes glyph is a unified-diff fragment: a deleted line, an added
 * line, and trailing context, each code line beside its gutter mark. Drawn
 * on FilesGlyph's exact 14×20 artwork box with the same 1.5 stroke, so the
 * two icons occupy the same footprint at the same `size` — equal width,
 * equal height, equal stroke weight. */
export function DiffPanelGlyph({ size = 28 }: { size?: number }) {
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
      <path d="M0.75 2.5h3M6.5 2.5h6.75" />
      <path d="M0.75 10h3M2.25 8.5v3M6.5 10h6.75" />
      <path d="M6.5 17.5h4.5" />
    </svg>
  );
}
