import type { FsChangeRepo } from "@protocol";
import { changeStatus, repoLabel, type ChangeItem } from "../../workspace/changes";
import { RefreshIcon } from "../RefreshIcon";
import type { ReviewProgress } from "../../workspace/review-progress";
import { WorkspaceTabs, type WorkspaceSurface } from "../WorkspaceTabs";

export function ChangesHeader({
  phone,
  loaded,
  itemCount,
  reviewedCount,
  headerCount,
  pending,
  onRefresh,
  onClose,
  onSwitch,
}: {
  phone: boolean;
  loaded: boolean;
  itemCount: number;
  reviewedCount: number;
  headerCount: string;
  pending: boolean;
  onRefresh: () => void;
  onClose: () => void;
  /** Phone drawer view switch (Files ⇄ Changes), shown in the title's place. */
  onSwitch?: (surface: WorkspaceSurface) => void;
}) {
  return (
    <header className="diff-panel-head">
      {phone && (
        <button className="diff-panel-icon-btn diff-panel-close" onClick={onClose} aria-label="Back to conversation">
          ‹
        </button>
      )}
      {phone && onSwitch ? (
        <WorkspaceTabs active="diff-panel" onSwitch={onSwitch} />
      ) : (
        <div className="diff-panel-title-block">
          <h2>Workspace changes</h2>
          <span className="diff-panel-subtitle">Working tree versus Git HEAD</span>
        </div>
      )}
      {loaded && itemCount > 0 && (
        <span
          className="diff-panel-progress"
          aria-label={`${reviewedCount} of ${itemCount} visible files reviewed`}
        >
          {reviewedCount} / {itemCount} reviewed
        </span>
      )}
      {loaded && <span className="diff-panel-count">{headerCount}</span>}
      <button
        className="diff-panel-icon-btn diff-panel-refresh"
        onClick={onRefresh}
        disabled={pending}
        title="Refresh workspace changes"
        aria-label="Refresh workspace changes"
      >
        <RefreshIcon />
      </button>
      {!phone && (
        <button className="diff-panel-icon-btn diff-panel-close" onClick={onClose} title="Close" aria-label="Close workspace changes">
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
    <nav className="diff-panel-rail" aria-label="Changed files">
      {repos.map((repo) => (
        <section className="diff-panel-repo" key={repo.root || "."}>
          <h3 title={repo.root || rootLabel}>{repoLabel(repo.root, rootLabel)}</h3>
          {repo.error && <div className="diff-panel-repo-note diff-panel-repo-error">{repo.error}</div>}
          {repo.entries.map((entry) => {
            const item = itemsByPath.get(entry.path);
            if (!item) return null;
            const status = changeStatus(entry.status);
            const reviewed = reviewProgress.has(entry.path);
            return (
              <button
                key={entry.path}
                className={
                  "diff-panel-file" +
                  (selectedPath === entry.path ? " is-active" : "") +
                  (reviewed ? " is-reviewed" : "")
                }
                onClick={() => onSelect(item)}
                title={entry.path}
                aria-current={selectedPath === entry.path ? "true" : undefined}
              >
                <span className={`diff-panel-status diff-panel-status-${status.code}`} aria-label={status.label} title={status.label}>
                  {status.code}
                </span>
                <span className="diff-panel-file-name">{item.displayPath}</span>
                <span
                  className="diff-panel-reviewed-mark"
                  aria-label={reviewed ? "Reviewed" : "Unreviewed"}
                  title={reviewed ? "Reviewed" : "Unreviewed"}
                >
                  {reviewed ? "✓" : "○"}
                </span>
              </button>
            );
          })}
          {repo.truncated && <div className="diff-panel-repo-note">More changed files were omitted.</div>}
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
    <div className="diff-panel-file-head">
      {phone && (
        <button
          className="diff-panel-nav-btn"
          onClick={() => onMove(-1)}
          disabled={index <= 0}
          aria-label="Previous changed file"
          title="Previous changed file"
        >
          ‹
        </button>
      )}
      <div className="diff-panel-current-file">
        <span className="diff-panel-current-path" title={item.path}>{item.path}</span>
        <span className={`diff-panel-current-status diff-panel-status-${status.code}`}>
          {status.label}
        </span>
      </div>
      <span className="diff-panel-position" aria-label={`Change ${index + 1} of ${itemCount}`}>
        {index + 1} / {itemCount}
      </span>
      {phone && (
        <button
          className="diff-panel-nav-btn"
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
    <div className="diff-panel-progress-tools" aria-label="Review progress controls">
      <button
        type="button"
        className="diff-panel-review-toggle"
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
        className="diff-panel-next-unreviewed"
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

