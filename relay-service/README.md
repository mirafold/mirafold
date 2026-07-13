# genui-relay

The hosted relay for [Mirafold](https://github.com/kserrec/genui-shell) — a
**dumb, end-to-end-blind WebSocket forwarder**. It lets a Mirafold daemon
running on your machine be reached from a phone or a second device without
opening any inbound port: the daemon dials *out* to the relay, the browser
connects *in*, and the relay shuttles opaque frames between them. It is the
paid tier's substrate (PLAN Phase R).

> This directory is the seed of the standalone, closed-source `genui-relay`
> repo — the open-core split (Mirafold is MIT; the hosted service is not).
> It lives inside the genui-shell repo during development so it can be verified
> against the real daemon (`server/relay-service.itest.ts`); it moves to its
> own private repo at deploy time.

## What it does, and deliberately does not

- **Matches** one daemon dial-in (`/daemon?pair=<id>`) to any number of browser
  viewports (`/ws?pair=<id>`) by pair id, and forwards frames between them.
- **Never parses payloads.** The `p` field of every envelope is the
  end-to-end-encrypted WireMsg/ClientMsg (AES-GCM, keyed off the pairing code
  the relay never sees — see genui-shell `server/relay-crypto.ts`). The relay
  routes on `t`/`v`/`pair` only. It logs no frame contents and stores nothing.
- **Serves no application bundle.** The only HTTP it answers is `GET /health`.

### The trust decision (why it serves no JS)

End-to-end encryption stops the relay *reading* your traffic. But a relay that
also served the phone's app bundle could ship tampered JavaScript that reads
the pairing code out of the URL fragment before encryption ever happens — the
honest asterisk on every browser "E2E" story.

genui-relay closes that hole structurally: **it is a pure forwarder and serves
no JS.** The phone loads the Mirafold web app from a **separate static
origin** (the landing-page host), and only *then* opens an encrypted WebSocket
to the relay. A compromised relay can drop or scramble ciphertext (denial of
service) but can neither read it nor inject code into the page that produced
it. (The considered alternative — tunnelling the app bundle *through* the
daemon so client and daemon are always the same version — is a larger change
kept in reserve; Mirafold's tolerant wire schemas already make the
static-origin path's version skew survivable.)

### Versioning

The relay protocol version is baked into the pairing key derivation on the
daemon/browser side, so a future protocol bump is a clean break **by
construction**: an old client against a new relay simply fails to pair, which
the user sees as "wrong pairing code." There is nothing to negotiate here.

## Hardening (the DoS posture)

Everything is bounded and refused rather than degraded, mirroring the daemon.
All values are env-overridable (`src/limits.ts`):

| env | default | meaning |
| --- | --- | --- |
| `RELAY_MAX_CONNECTIONS` | 2000 | hard ceiling on live sockets |
| `RELAY_MAX_CONNECTIONS_PER_IP` | 64 | live sockets one source IP may hold (0 disables) |
| `RELAY_MAX_PAIRS` | 1000 | distinct daemons at once |
| `RELAY_MAX_VIEWPORTS_PER_PAIR` | 8 | browser viewports per pair |
| `RELAY_MAX_PAYLOAD_BYTES` | 8000000 | single-frame ceiling |
| `RELAY_RATE_MAX_FRAMES` / `RELAY_RATE_WINDOW_MS` | 480 / 1000 | per-connection frame rate |
| `RELAY_HEARTBEAT_MS` | 30000 | ws ping interval; a missed ping is reaped |
| `RELAY_MAX_SOCKETS` | 2400 | raw TCP sockets accepted at once — the pre-handshake floor; keep ≥ `RELAY_MAX_CONNECTIONS`; 0 = unbounded |
| `RELAY_HEADERS_TIMEOUT_MS` | 15000 | ms to receive the full request headers before a stalled handshake is cut; 0 disables |
| `RELAY_REQUEST_TIMEOUT_MS` | 20000 | ms to receive the whole request before a stalled handshake is cut; 0 disables |
| `RELAY_CONNECTION_CHECK_MS` | 5000 | how often stalled handshakes are swept for the two timeouts above; 0 disables both |
| `RELAY_CLIENT_IP_HEADER` | *(unset)* | trusted header carrying the true client IP |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | listen address |

A guessably short pair id, a second daemon on a taken id, an unknown pair id, a
capacity cap, a per-source cap, or a frame flood each get a clean close (codes
in `src/contract.ts`).

**The per-source cap (`RELAY_MAX_CONNECTIONS_PER_IP`)** is what stops one host
from opening thousands of quiet connections to eat the whole global budget, or
squatting every pair slot with junk daemons — the per-*connection* frame-rate
limit can't, since that attack is many idle connections rather than one noisy
one. Behind a proxy (Fly.io), the socket address is the proxy's and is shared
by everyone, so set `RELAY_CLIENT_IP_HEADER` to the header the edge stamps with
the real client IP (`fly-client-ip` on Fly — already set in `fly.toml`). Leave
it unset only when clients reach the process directly; **never** set it on a
port an untrusted client can hit without the proxy, because the header is
spoofable there.

## Run it

```
npm install
npm run dev          # tsx, from source
# or
npm run build && npm start
```

Point a daemon at it: `MIRAFOLD_RELAY_URL=ws://localhost:8080 mirafold`.

## Deploy (Fly.io)

Needs a Fly.io account and a domain you own. TLS is terminated by the platform;
the daemon then uses `wss://`.

```
fly launch --no-deploy
fly deploy
fly certs add relay.your-domain.example
```

Then `MIRAFOLD_RELAY_URL=wss://relay.your-domain.example`. See `fly.toml` for the
single-instance config and the health check. Keep `auto_stop_machines = false`:
a stopped machine drops every live pairing.
