import { Component as ReactComponent, type ComponentType, type ReactNode } from "react";
import type { Action } from "@protocol";
import { registrySchemas, type ComponentName } from "@registry-spec";
import { registry } from "./index";
import { ActionContext } from "./actions";

// A malformed instruction must never break the UI (PLAN 1.4). Three layers:
//   1. unknown component name  → fallback
//   2. props fail the schema   → fallback
//   3. component throws anyway → error boundary → fallback
// The fallback degrades to styled text: a quiet warning plus the raw props,
// so the agent's content is still legible even when the UI instruction isn't.

function Fallback({
  component,
  props,
  reason,
}: {
  component: string;
  props: unknown;
  reason: string;
}) {
  return (
    <div className="rc rc-fallback">
      <div className="rc-fallback-note">
        ⚠ couldn't render <code>{component}</code> ({reason}) — showing raw content
      </div>
      <pre>{JSON.stringify(props, null, 2)}</pre>
    </div>
  );
}

class RenderBoundary extends ReactComponent<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function RenderBlock({
  component,
  props,
  renderId,
  onAction,
}: {
  component: string;
  props: Record<string, unknown>;
  renderId: string;
  // Provided by the shell via RenderZone; binds this block's identity to
  // every action it emits. Components ask; the shell sends.
  onAction: (action: Action, sourceId: string) => void;
}) {
  const name = component as ComponentName;
  const Impl = registry[name] as ComponentType<Record<string, unknown>> | undefined;
  const schema = registrySchemas[name];
  if (!Impl || !schema) {
    return <Fallback component={component} props={props} reason="unknown component" />;
  }
  const parsed = schema.safeParse(props);
  if (!parsed.success) {
    return <Fallback component={component} props={props} reason="invalid props" />;
  }
  return (
    <RenderBoundary
      fallback={<Fallback component={component} props={props} reason="component crashed" />}
    >
      <ActionContext.Provider value={(action) => onAction(action, renderId)}>
        <Impl {...(parsed.data as Record<string, unknown>)} />
      </ActionContext.Provider>
    </RenderBoundary>
  );
}
