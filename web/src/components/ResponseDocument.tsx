import type { ReactNode } from "react";

export function ResponseDocument({
  responseKey,
  continuation,
  children,
}: {
  responseKey: number;
  continuation: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        "response-document" +
        (continuation ? " response-document-continuation" : "")
      }
      data-response-key={responseKey}
      data-response-continuation={continuation ? "" : undefined}
    >
      {children}
    </div>
  );
}
