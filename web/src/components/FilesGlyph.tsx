/* The Explorer files glyph — the desktop activity bar's Files toggle (the
   phone status bar carries WorkspaceGlyph instead). A single document sheet,
   drawn symmetric about the viewBox center — a two-page glyph reads as
   hanging right (its front page's mass sits right of center) even when its
   bounds are centered. Tight viewBox: the drawing fills the box. */
export function FilesGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="5 2 14 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7.5L13.5 3z" />
      <path d="M13.5 3v3a1.5 1.5 0 0 0 1.5 1.5h3" />
    </svg>
  );
}
