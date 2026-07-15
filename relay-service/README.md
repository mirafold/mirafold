# relay-service — moved

The hosted relay — a dumb, end-to-end-blind WebSocket forwarder that pairs a
local Mirafold daemon with remote browser viewports — now lives in its own
private repo, **`genui-relay`** (`mirafold/mirafold-relay` on GitHub). This
directory held a byte-identical development copy until the relay's first
deploy; the relay is live, so that copy is retired and `genui-relay` is the
single source of truth. Nothing here is imported by the product.

Only one thing in this repo still touches the relay's code: the real-daemon
integration test `server/relay-service.itest.ts` (Tier 2, `yarn test:server`)
imports the relay under test from the **sibling checkout** at
`../genui-relay/src/` — the same sibling-directory layout the workspace
already uses. To run that test, check out `genui-relay` next to this repo and
`npm install` inside it; without the sibling, the rest of the Tier-2 suite is
unaffected.

The daemon-side halves of the relay conversation are unchanged and live where
they always did: `server/relay-protocol.ts` (routing contract),
`server/relay-crypto.ts` (E2E encryption), `server/relay-client.ts` (the
daemon's dial-out). The itest asserts the routing contract in both repos
stays in agreement.
