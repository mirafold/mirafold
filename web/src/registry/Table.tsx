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
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>
                    {typeof cell === "number" ? cell : <Md text={cell} inline />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
