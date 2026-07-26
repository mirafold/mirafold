/* The settings/tool gear — one drawing, four homes: the status bar's settings
   button, the in-session status line, the subagent group head, and the fleet
   details activity line. It replaces the bare ⚙ character (U+2699), which the
   system renders from the color-emoji font — shaded, dimensional and filled,
   the only glyph in the bar that left the text font (2026-07-25, Kyle).

   Drawn as one closed outline around the notched edge plus a hub circle, no
   fill, so it sits in the same flat line language as FilesGlyph and the ⌂/☀/☾
   text glyphs beside it. Six teeth, not the conventional eight: at button size
   eight gaps mush into a blur. `size` takes any CSS length so the inline uses
   can ride the surrounding text at "1em" while the button pins 20px. */
export function GearGlyph({ size = 20 }: { size?: number | string }) {
  return (
    <svg
      className="gear-glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9.81 2.86 A9.4 9.4 0 0 1 14.19 2.86 L13.71 4.87 A7.332 7.332 0 0 1 17.32 6.95 L18.82 5.53 A9.4 9.4 0 0 1 21.01 9.33 L19.03 9.92 A7.332 7.332 0 0 1 19.03 14.08 L21.01 14.67 A9.4 9.4 0 0 1 18.82 18.47 L17.32 17.05 A7.332 7.332 0 0 1 13.71 19.13 L14.19 21.14 A9.4 9.4 0 0 1 9.81 21.14 L10.29 19.13 A7.332 7.332 0 0 1 6.68 17.05 L5.18 18.47 A9.4 9.4 0 0 1 2.99 14.67 L4.97 14.08 A7.332 7.332 0 0 1 4.97 9.92 L2.99 9.33 A9.4 9.4 0 0 1 5.18 5.53 L6.68 6.95 A7.332 7.332 0 0 1 10.29 4.87 Z" />
      <circle cx="12" cy="12" r="3.57" />
    </svg>
  );
}
