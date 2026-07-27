// The front-end registry: render-message component names → React components.
// Keyed by the shared spec (@registry-spec), so adding a component means
// adding a schema there and an entry here — the type checker enforces both.

import type { ComponentType } from "react";
import type { ComponentName, ComponentProps } from "@registry-spec";
import { Card } from "./Card";
import { List } from "./List";
import { Table } from "./Table";
import { LinkGroup } from "./LinkGroup";
import { Chart } from "./Chart";
import { TodoList } from "./TodoList";
import { KeyValue } from "./KeyValue";
import { Progress } from "./Progress";
import { Timeline } from "./Timeline";
import { FileTree } from "./FileTree";
import { Question } from "./Question";
import { Diff } from "./Diff";
import { Stat } from "./Stat";
import { Code } from "./Code";
import { StatusList } from "./StatusList";

export const registry: { [N in ComponentName]: ComponentType<ComponentProps<N>> } = {
  card: Card,
  list: List,
  table: Table,
  "link-group": LinkGroup,
  chart: Chart,
  "todo-list": TodoList,
  "key-value": KeyValue,
  progress: Progress,
  timeline: Timeline,
  "file-tree": FileTree,
  question: Question,
  diff: Diff,
  stat: Stat,
  code: Code,
  "status-list": StatusList,
};
