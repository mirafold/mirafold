/** The one refresh glyph both shell panels draw (Changes chrome, folder tree
 *  actions) — stroke styling comes from each panel's own CSS class. */
export function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.4 7A5.5 5.5 0 1 0 13 10.2" />
      <path d="M10.1 3.8h3.3V.5" />
    </svg>
  );
}
