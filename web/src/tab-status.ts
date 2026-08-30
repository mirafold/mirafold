// The browser tab is a status light layered on the brand mark: the M favicon
// always shows, with a corner badge when the session is busy or waiting on
// permission, so a row of tabs reads as a fleet view.

export type TabState = "idle" | "busy" | "permission";

const TITLES: Record<TabState, string> = {
  permission: "⚠ permission — Mirafold",
  busy: "✳ working — Mirafold",
  idle: "Mirafold",
};

/** Repaint the tab title + favicon for the session state. */
export function paintTabStatus(state: TabState) {
  document.title = TITLES[state];
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Literal geometry + colors (exception to the tokens-only rule): a canvas favicon can't load
  // the SVG file or consume CSS vars — the rounded surface, polyline, and
  // #40d17f mirror web/public/favicon.svg by value, the badge colors the
  // dark palette's --info/--warn-fg.
  ctx.beginPath();
  ctx.roundRect(0, 0, 64, 64, 13);
  ctx.fillStyle = "#0a0d13";
  ctx.fill();
  const m: [number, number][] = [
    [24, 47], [18, 47], [18, 17], [32, 36], [46, 17], [46, 47], [40, 47],
  ];
  ctx.beginPath();
  ctx.moveTo(m[0][0], m[0][1]);
  for (const [x, y] of m.slice(1)) ctx.lineTo(x, y);
  ctx.strokeStyle = "#40d17f";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  if (state !== "idle") {
    // A background-colored halo so the badge reads against the M itself.
    ctx.beginPath();
    ctx.arc(46, 46, 18, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0d13";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(46, 46, 14, 0, Math.PI * 2);
    ctx.fillStyle = state === "permission" ? "#d4a852" : "#7ab8ff";
    ctx.fill();
  }
  const href = canvas.toDataURL("image/png");
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
  if (links.length === 0) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = href;
    document.head.appendChild(link);
    return;
  }
  // Overwrite every icon candidate — with the SVG + PNG fallbacks all
  // pointing at one image, the browser's pick doesn't matter.
  for (const link of links) {
    link.type = "image/png";
    link.href = href;
  }
}
