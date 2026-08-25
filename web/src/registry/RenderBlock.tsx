import { Component as ReactComponent, memo, useMemo, type ComponentType, type ReactNode } from "react";
import type { Action } from "@protocol";
import { clientSchemas, type ComponentName } from "@registry-spec";
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

/** Contains a throw from one piece of agent-derived content to that piece —
 *  the registry components use it around every paint, and the output zone
 *  wraps every transcript row in it so a malformed engine record can never
 *  unmount the shell (socket, prompt box, permission bar included). */
export class RenderBoundary extends ReactComponent<
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

export const RenderBlock = memo(function RenderBlock({
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
  // Own-property lookups only: `component` is a wire string, and a prototype
  // key ("toString", "constructor") would otherwise pass both lookups truthy
  // and then throw in safeParse — during THIS component's render, above the
  // boundary it installs, unmounting the whole zone (2026-07-28 review).
  const Impl = Object.hasOwn(registry, name)
    ? (registry[name] as ComponentType<Record<string, unknown>>)
    : undefined;
  // Tolerant twin, not the strict source schema (R.4h): a newer daemon's
  // extra props must strip, not fail this whole component into the fallback.
  const schema = Object.hasOwn(clientSchemas, name) ? clientSchemas[name] : undefined;
  // Re-parsed only when the props object changes — an update-in-place render
  // arrives as a new props object, everything else re-renders with the same one.
  const parsed = useMemo(() => schema?.safeParse(props), [schema, props]);
  if (!Impl || !schema || !parsed) {
    return <Fallback component={component} props={props} reason="unknown component" />;
  }
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
});
