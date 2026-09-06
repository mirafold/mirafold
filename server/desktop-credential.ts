import { closeSync, fstatSync } from "node:fs";
import { Socket } from "node:net";

export const DESKTOP_CREDENTIAL_FLAG = "--mirafold-desktop";
export const DESKTOP_CREDENTIAL_MAX_BYTES = 43; // mf_ + at most 40 base32 characters
export const DESKTOP_CREDENTIAL_TIMEOUT_MS = 2_000;

export type DesktopCredential =
  | { kind: "terminal" }
  | { kind: "desktop"; key: string; problem?: never }
  | {
      kind: "desktop";
      key?: never;
      problem: "missing-input" | "invalid-key" | "too-large" | "timeout" | "input-error";
    };

/** An explicit daemon-only configuration, never an environment to inherit. */
export type RelayRuntimeConfig = {
  MIRAFOLD_RELAY_URL?: string;
  MIRAFOLD_APP_URL?: string;
  MIRAFOLD_ENTITLEMENT_URL?: string;
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
};

/** All three billing/relay consumers receive this same resolution. Leave
 * terminal values intact: their established trimming and ops precedence stay
 * with the consumers. A failed Desktop read must not revive an ambient key. */
export function resolveCredentialConfig(
  env: RelayRuntimeConfig,
  credential: DesktopCredential,
): RelayRuntimeConfig {
  return {
    MIRAFOLD_RELAY_URL: env.MIRAFOLD_RELAY_URL,
    MIRAFOLD_APP_URL: env.MIRAFOLD_APP_URL,
    MIRAFOLD_ENTITLEMENT_URL: env.MIRAFOLD_ENTITLEMENT_URL,
    MIRAFOLD_ENTITLEMENT_TOKEN: env.MIRAFOLD_ENTITLEMENT_TOKEN,
    MIRAFOLD_LICENSE_KEY: credential.kind === "desktop" ? credential.key : env.MIRAFOLD_LICENSE_KEY,
  };
}

function closeStdin(): void {
  try {
    closeSync(0);
  } catch {
    // A missing/already-closed descriptor is also unavailable to children.
  }
}

/** Only the private flag claims stdin. Await this before creating a server,
 * session registry, or child. No input or error text is ever logged here. */
export async function readDesktopCredential(argv = process.argv): Promise<DesktopCredential> {
  if (!argv.slice(2).includes(DESKTOP_CREDENTIAL_FLAG)) return { kind: "terminal" };
  for (let i = argv.length - 1; i >= 2; i--) {
    if (argv[i] === DESKTOP_CREDENTIAL_FLAG) argv.splice(i, 1);
  }

  try {
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isSocket()) {
      closeStdin();
      return { kind: "desktop", problem: "input-error" };
    }
  } catch {
    closeStdin();
    return { kind: "desktop", problem: "input-error" };
  }

  return new Promise<DesktopCredential>((resolve) => {
    const bytes = Buffer.alloc(DESKTOP_CREDENTIAL_MAX_BYTES);
    // Bound the OS read too; a hostile producer never gets a payload-sized
    // allocation, even for the first chunk or a never-ending stream.
    const chunk = Buffer.alloc(DESKTOP_CREDENTIAL_MAX_BYTES + 1);
    const deadlineAt = performance.now() + DESKTOP_CREDENTIAL_TIMEOUT_MS;
    let length = 0;
    let result: DesktopCredential | undefined;
    let input: Socket;
    const finish = (next: DesktopCredential) => {
      if (result) return;
      result = next;
      input.destroy();
    };
    const timer = setTimeout(
      () => finish({ kind: "desktop", problem: "timeout" }),
      DESKTOP_CREDENTIAL_TIMEOUT_MS,
    );
    const closed = () => {
      clearTimeout(timer);
      // libuv deliberately leaves standard descriptors open on Unix. Wait
      // until its read handle has stopped, then close fd 0 ourselves.
      closeStdin();
      bytes.fill(0);
      chunk.fill(0);
      resolve(result ?? { kind: "desktop", problem: "input-error" });
    };

    try {
      input = new Socket({
        fd: 0,
        readable: true,
        writable: false,
        onread: {
          buffer: chunk,
          callback: (count, buffer) => {
            if (result) return false;
            if (performance.now() >= deadlineAt) {
              finish({ kind: "desktop", problem: "timeout" });
              return false;
            }
            if (length + count > DESKTOP_CREDENTIAL_MAX_BYTES) {
              finish({ kind: "desktop", problem: "too-large" });
              return false;
            }
            bytes.set(buffer.subarray(0, count), length);
            length += count;
            return true;
          },
        },
      });
      input.once("end", () => {
        if (performance.now() >= deadlineAt) {
          finish({ kind: "desktop", problem: "timeout" });
          return;
        }
        if (length === 0) {
          finish({ kind: "desktop", problem: "missing-input" });
          return;
        }
        try {
          const key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
          // The billing service's existing grammar, with no whitespace/BOM
          // normalization. EOF is the sole frame terminator, never a newline.
          finish(/^mf_[a-z2-7]{20,40}(?![\s\S])/.test(key)
            ? { kind: "desktop", key }
            : { kind: "desktop", problem: "invalid-key" });
        } catch {
          finish({ kind: "desktop", problem: "invalid-key" });
        }
      });
      input.once("error", () => {
        result = { kind: "desktop", problem: "input-error" };
        input.destroy();
      });
      input.once("close", closed);
      input.resume();
    } catch {
      result = { kind: "desktop", problem: "input-error" };
      closed();
    }
  });
}
