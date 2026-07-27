import type { ComponentProps } from "@registry-spec";

// Inline workspace image (screenshots, rendered pages, saved plots). The
// pixels arrive as a daemon-filled data: URI whose shape the schema regex
// already validated — a src of any other form never parses, so it never
// reaches this element. No src = the daemon refused or couldn't inline;
// show why, plainly, instead of a broken-image glyph.

export function Image({ path, alt, caption, src, error }: ComponentProps<"image">) {
  if (!src) {
    return (
      <div className="rc rc-image rc-image-missing">
        <span className="rc-image-missing-note">
          image unavailable{error ? ` — ${error}` : ""}
        </span>
        <code className="rc-image-path">{path}</code>
      </div>
    );
  }
  return (
    <figure className="rc rc-image">
      <img className="rc-image-img" src={src} alt={alt} />
      <figcaption className="rc-image-foot">
        {caption && <span className="rc-image-caption">{caption}</span>}
        <code className="rc-image-path">{path}</code>
      </figcaption>
    </figure>
  );
}
