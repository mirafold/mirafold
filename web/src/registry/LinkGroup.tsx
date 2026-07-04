import type { ComponentProps } from "@registry-spec";

export function LinkGroup({ title, links }: ComponentProps<"link-group">) {
  return (
    <div className="rc rc-links">
      {title && <div className="rc-title">{title}</div>}
      <div className="rc-links-row">
        {links.map((link, i) => (
          <a key={i} className="rc-link" href={link.href} target="_blank" rel="noopener noreferrer">
            <span className="rc-link-label">{link.label} ↗</span>
            {link.description && <span className="rc-detail">{link.description}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
