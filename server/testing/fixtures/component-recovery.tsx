import { createRoot } from "react-dom/client";
import { OutputZone } from "../../../web/src/components/OutputZone";
import { registry } from "../../../web/src/registry";
import type { ComponentProps } from "../../registry-spec";
import type { ZoneMsg } from "../../../web/src/transport/session-bus";

// Only the browser test bundles this deliberately throwing component. Keeping
// it outside the production registry decouples recovery proof from validation.
const attempts = { inner: 0, outer: 0 };
let outer = false;
function ThrowingProgress(props: ComponentProps<"progress">) {
  if (props.label === "throw") { attempts.inner++; throw new Error("CU deliberate component throw"); }
  return <input aria-label={props.label} defaultValue={String(props.percent)} />;
}
Object.defineProperty(registry, "progress", { configurable: true, get() {
  if (outer) { attempts.outer++; throw new Error("CU deliberate registry throw"); }
  return ThrowingProgress;
} });
let listener: ((message: ZoneMsg) => void) | undefined;
const subscribe = (next: (message: ZoneMsg) => void) => { listener = next; return () => { listener = undefined; }; };
const root = createRoot(document.getElementById("root")!);
const show = (sessionKey = "recovery-fixture", details = false) => root.render(<OutputZone subscribe={subscribe} sendAction={() => {}} busy={false} focusPrompt={() => {}} sessionKey={sessionKey} details={details} />);
show();
Object.assign(window, { cu: { attempts, emit: (m: ZoneMsg) => listener?.(m), show, setOuter: (value: boolean) => { outer = value; }, ready: () => !!listener } });
