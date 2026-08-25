export type FolderTreeEntryKind = "dir" | "file" | "symlink";

/** The glyph is for leaves only: a directory row carries no icon (Kyle,
 *  2026-08-25 — the chevron already says "folder"), just the spacer that
 *  keeps names in one column (`FolderTreeNodeSpacer`). */
export type FolderTreeLeafKind = Exclude<FolderTreeEntryKind, "dir">;

export type FolderTreeNodeGlyphKind =
  | "symlink"
  | "code"
  | "config"
  | "document"
  | "style"
  | "image"
  | "file";

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "go",
  "h",
  "hpp",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "lean",
  "mjs",
  "php",
  "py",
  "rb",
  "rkt",
  "rs",
  "scala",
  "sh",
  "swift",
  "ts",
  "tsx",
  "zsh",
]);

const CONFIG_EXTENSIONS = new Set([
  "conf",
  "csv",
  "ini",
  "json",
  "jsonc",
  "lock",
  "toml",
  "xml",
  "yaml",
  "yml",
]);

const DOCUMENT_EXTENSIONS = new Set(["adoc", "md", "mdx", "pdf", "rst", "txt"]);
const STYLE_EXTENSIONS = new Set(["css", "less", "sass", "scss", "styl"]);
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const CONFIG_NAMES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "dockerfile",
  "makefile",
]);

/** A deliberately bounded file-family classifier for the folder tree's tiny
 * decorative glyph. It communicates broad shape, not a promise to identify
 * every language or reproduce a full IDE icon theme. */
export function folderTreeNodeGlyphKind(
  name: string,
  entryKind: FolderTreeLeafKind,
): FolderTreeNodeGlyphKind {
  if (entryKind === "symlink") return "symlink";

  const lower = name.toLowerCase();
  if (CONFIG_NAMES.has(lower)) return "config";
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot + 1) : "";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (CONFIG_EXTENSIONS.has(extension)) return "config";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (STYLE_EXTENSIONS.has(extension)) return "style";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "file";
}

export function FolderTreeChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`folder-tree-chevron${open ? " is-open" : ""}`}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 2.5 7.5 6 4 9.5" />
    </svg>
  );
}

/** The icon column, empty: holds a directory name in line with file names. */
export function FolderTreeNodeSpacer() {
  return <span className="folder-tree-node-icon folder-tree-node-spacer" aria-hidden="true" />;
}

export function FolderTreeNodeGlyph({
  name,
  entryKind,
}: {
  name: string;
  entryKind: FolderTreeLeafKind;
}) {
  const kind = folderTreeNodeGlyphKind(name, entryKind);
  const page = (
    <>
      <path d="M3 1.75h6.1L13 5.65v8.6H3z" />
      <path d="M9.1 1.75v3.9H13" />
    </>
  );

  return (
    <svg
      className={`folder-tree-node-icon folder-tree-node-icon-${kind}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "symlink" && (
        <>
          <path d="M6.35 5.25H5a3 3 0 0 0 0 6h1.35" />
          <path d="M9.65 5.25H11a3 3 0 0 1 0 6H9.65" />
          <path d="M5.75 8.25h4.5" />
        </>
      )}
      {kind === "code" && (
        <>
          {page}
          <path d="m6.25 8-1.5 1.5 1.5 1.5M9.75 8l1.5 1.5-1.5 1.5" />
        </>
      )}
      {kind === "config" && (
        <>
          {page}
          <path d="M5 8h6M5 11h6" />
          <circle cx="7" cy="8" r="0.65" fill="currentColor" stroke="none" />
          <circle cx="9.5" cy="11" r="0.65" fill="currentColor" stroke="none" />
        </>
      )}
      {kind === "document" && (
        <>
          {page}
          <path d="M5 8h6M5 10.25h6M5 12.5h4" />
        </>
      )}
      {kind === "style" && (
        <>
          {page}
          <path d="M6.5 7.5 5.75 12M10.25 7.5 9.5 12M5 9h6M4.65 10.75h6" />
        </>
      )}
      {kind === "image" && (
        <>
          {page}
          <circle cx="6" cy="8" r="0.75" />
          <path d="m5 12 2.25-2.25 1.5 1.5 1.1-1.1L11.5 12" />
        </>
      )}
      {kind === "file" && page}
    </svg>
  );
}
