import type { FsChangeRepo } from "@protocol";
import { changeStatus, repoLabel, type ChangeItem } from "../../changes";
import { RefreshIcon } from "../RefreshIcon";
import type { ReviewProgress } from "../../review-progress";

export function ChangesHeader({
  phone,
  loaded,
  itemCount,
  reviewedCount,
  headerCount,
  pending,
  onRefresh,
  onClose,
}: {
  phone: boolean;
  loaded: boolean;
  itemCount: number;
  reviewedCount: number;
  headerCount: string;
  pending: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <header className="changes-head">
      {phone && (
        <button className="changes-icon-btn changes-close" onClick={onClose} aria-label="Back to conversation">
          ‹
        </button>
      )}
      <div className="changes-title-block">
        <h2>Workspace changes</h2>
        <span className="changes-subtitle">Working tree versus Git HEAD</span>
      </div>
      {loaded && itemCount > 0 && (
        <span
          className="changes-progress"
          aria-label={`${reviewedCount} of ${itemCount} visible files reviewed`}
        >
          {reviewedCount} / {itemCount} reviewed
        </span>
      )}
      {loaded && <span className="changes-count">{headerCount}</span>}
      <button
        className="changes-icon-btn changes-refresh"
        onClick={onRefresh}
        disabled={pending}
        title="Refresh workspace changes"
        aria-label="Refresh workspace changes"
      >
        <RefreshIcon />
      </button>
      {!phone && (
        <button className="changes-icon-btn changes-close" onClick={onClose} title="Close" aria-label="Close workspace changes">
          ×
        </button>
      )}
    </header>
  );
}

export function ChangesRail({
  repos,
  itemsByPath,
  selectedPath,
  reviewProgress,
  rootLabel,
  onSelect,
}: {
  repos: readonly FsChangeRepo[];
  itemsByPath: ReadonlyMap<string, ChangeItem>;
  selectedPath?: string;
  reviewProgress: ReviewProgress;
  rootLabel?: string;
  onSelect: (item: ChangeItem) => void;
}) {
  return (
    <nav className="changes-rail" aria-label="Changed files">
      {repos.map((repo) => (
        <section className="changes-repo" key={repo.root || "."}>
          <h3 title={repo.root || rootLabel}>{repoLabel(repo.root, rootLabel)}</h3>
          {repo.error && <div className="changes-repo-note changes-repo-error">{repo.error}</div>}
          {repo.entries.map((entry) => {
            const item = itemsByPath.get(entry.path);
            if (!item) return null;
            const status = changeStatus(entry.status);
            const reviewed = reviewProgress.has(entry.path);
            return (
              <button
                key={entry.path}
                className={
                  "changes-file" +
                  (selectedPath === entry.path ? " is-active" : "") +
                  (reviewed ? " is-reviewed" : "")
                }
                onClick={() => onSelect(item)}
                title={entry.path}
                aria-current={selectedPath === entry.path ? "true" : undefined}
              >
                <span className={`changes-status changes-status-${status.code}`} aria-label={status.label} title={status.label}>
                  {status.code}
                </span>
                <span className="changes-file-name">{item.displayPath}</span>
                <span
                  className="changes-reviewed-mark"
                  aria-label={reviewed ? "Reviewed" : "Unreviewed"}
                  title={reviewed ? "Reviewed" : "Unreviewed"}
                >
                  {reviewed ? "✓" : "○"}
                </span>
              </button>
            );
          })}
          {repo.truncated && <div className="changes-repo-note">More changed files were omitted.</div>}
        </section>
      ))}
    </nav>
  );
}

export function ChangeFileHeader({
  phone,
  item,
  index,
  itemCount,
  onMove,
}: {
  phone: boolean;
  item: ChangeItem;
  index: number;
  itemCount: number;
  onMove: (delta: number) => void;
}) {
  const status = changeStatus(item.status);
  return (
    <div className="changes-file-head">
      {phone && (
        <button
          className="changes-nav-btn"
          onClick={() => onMove(-1)}
          disabled={index <= 0}
          aria-label="Previous changed file"
          title="Previous changed file"
        >
          ‹
        </button>
      )}
      <div className="changes-current-file">
        <span className="changes-current-path" title={item.path}>{item.path}</span>
        <span className={`changes-current-status changes-status-${status.code}`}>
          {status.label}
        </span>
      </div>
      <span className="changes-position" aria-label={`Change ${index + 1} of ${itemCount}`}>
        {index + 1} / {itemCount}
      </span>
      {phone && (
        <button
          className="changes-nav-btn"
          onClick={() => onMove(1)}
          disabled={index >= itemCount - 1}
          aria-label="Next changed file"
          title="Next changed file"
        >
          ›
        </button>
      )}
    </div>
  );
}

export function ReviewProgressControls({
  selectedRevision,
  selectedReviewed,
  hasNextUnreviewed,
  onToggleReviewed,
  onNextUnreviewed,
}: {
  selectedRevision?: string;
  selectedReviewed: boolean;
  hasNextUnreviewed: boolean;
  onToggleReviewed: () => void;
  onNextUnreviewed: () => void;
}) {
  return (
    <div className="changes-progress-tools" aria-label="Review progress controls">
      <button
        type="button"
        className="changes-review-toggle"
        onClick={onToggleReviewed}
        disabled={!selectedRevision}
        aria-pressed={selectedReviewed}
        aria-keyshortcuts="R"
        title={selectedRevision ? "Shortcut: R" : "An exact file revision is unavailable"}
      >
        {selectedReviewed ? "Unmark reviewed" : "Mark reviewed"}
      </button>
      <button
        type="button"
        className="changes-next-unreviewed"
        onClick={onNextUnreviewed}
        disabled={!hasNextUnreviewed}
        aria-keyshortcuts="N"
        title="Shortcut: N"
      >
        Next unreviewed
      </button>
    </div>
  );
}

