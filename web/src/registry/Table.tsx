import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";

export function Table({ title, columns, rows }: ComponentProps<"table">) {
  return (
    <div className="rc rc-table">
      {title && <div className="rc-title">{title}</div>}
      <div className="rc-table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th key={i}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Cells align to `columns` by index (the schema's contract), so
                every row renders exactly columns.length cells: surplus cells
                would escape the header, missing ones would ragged-shift the
                columns after them. */}
            {rows.map((row, r) => (
              <tr key={r}>
                {columns.map((_, c) => {
                  const cell = row[c];
                  return typeof cell === "number" ? (
                    <td key={c} className="rc-table-num">
                      {cell}
                    </td>
                  ) : (
                    <td key={c}>{cell !== undefined ? <Md text={cell} inline /> : null}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="rc-table-empty">no rows</div>}
      </div>
    </div>
  );
}
