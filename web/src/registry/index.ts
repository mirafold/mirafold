// The front-end registry: render-message component names → React components.
// Keyed by the shared spec (@registry-spec), so adding a component means
// adding a schema there and an entry here — the type checker enforces both.

import type { ComponentType } from "react";
import type { ComponentName, ComponentProps } from "@registry-spec";
import { Card } from "./Card";
import { List } from "./List";
import { Table } from "./Table";
import { Chart } from "./Chart";
import { LinkGroup } from "./LinkGroup";
import { KeyValue } from "./KeyValue";
import { Progress } from "./Progress";
import { Timeline } from "./Timeline";
import { FileTree } from "./FileTree";
import { Question } from "./Question";
import { Diff } from "./Diff";
import { Stat } from "./Stat";
import { Code } from "./Code";
import { Diagram } from "./Diagram";
import { Image } from "./Image";
import { Console } from "./Console";
import { StatusList } from "./StatusList";
import { TodoList } from "./TodoList";

// Entries in the spec's order (server/registry-spec.ts) — the two halves of
// the one-source-of-truth pairing read side by side.
export const registry: { [N in ComponentName]: ComponentType<ComponentProps<N>> } = {
  card: Card,
  list: List,
  table: Table,
  chart: Chart,
  "link-group": LinkGroup,
  "key-value": KeyValue,
  progress: Progress,
  timeline: Timeline,
  "file-tree": FileTree,
  question: Question,
  diff: Diff,
  stat: Stat,
  code: Code,
  diagram: Diagram,
  image: Image,
  console: Console,
  "status-list": StatusList,
  "todo-list": TodoList,
};
