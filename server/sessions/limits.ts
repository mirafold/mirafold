import { envInt } from "../env";

// The replay ring's two caps and the checkpoint ceiling that must exceed them,
// declared together because they are one contract: a checkpoint holds the whole
// ring, so a ceiling below the ring's byte cap makes every write throw, the
// idle unloader re-arm forever, and rename fail — with nothing naming the two
// knobs that disagree.

/** Replay depth: enough to reconstruct a long working session; beyond it the
 *  oldest messages fall off and a late viewport sees a truncated head. */
export const BUFFER_CAP = 4000;

/** The same ring, capped by BYTES as well. The count cap alone assumed every
 *  message was text the agent had to type; `render_image` broke that: a
 *  six-character path inlines up to 2 MB of picture into one buffered message,
 *  and render tools are auto-allowed. Measured: 40 image renders held 96 MB,
 *  and the count cap's own ceiling worked out to ~10 GB. Evict oldest-first on
 *  either cap. */
export const BUFFER_MAX_BYTES = envInt("SESSION_BUFFER_MAX_BYTES", 32_000_000);

/** Headroom over the ring for the checkpoint's metadata and prompt catalog. */
const CHECKPOINT_HEADROOM_BYTES = 8_000_000;

/** The largest checkpoint the store will write or read — the ring's byte cap
 *  plus headroom, so raising SESSION_BUFFER_MAX_BYTES can never outgrow it. */
export const MAX_CHECKPOINT_BYTES = BUFFER_MAX_BYTES + CHECKPOINT_HEADROOM_BYTES;
