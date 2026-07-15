import type { ComponentProps } from "@registry-spec";

// The terminal's live task list as a component. Synthesized server-side
// from TodoWrite and re-sent under one id per turn, so it updates in place (T2.5).
const MARK = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
} as const;

export function TodoList({ todos }: ComponentProps<"todo-list">) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="rc rc-todos">
      <div className="rc-todos-head">
        tasks · {done}/{todos.length}
      </div>
      <ul>
        {todos.map((t, i) => (
          <li key={i} className={`todo todo-${t.status}`}>
            <span className="todo-mark">{MARK[t.status]}</span>
            <span className="todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
