# Quiver — Architecture & Walkthrough

> A from-scratch, real-time **publish/subscribe message broker built directly on QUIC**
> (the transport behind HTTP/3), in pure Python with `asyncio` + `aioquic`.
> Every peer is authenticated by a self-signed **Ed25519** identity — no passwords,
> no certificate authority, no central trust.

This document is written for someone who has never seen the codebase. It explains
**what Quiver is, why it's built the way it is, how a message actually moves through
the system end-to-end, and what is left to build.** If you read only one file to
understand the project, read this one.

---

## 1. The one-paragraph version

Quiver lets many clients exchange messages by **topic** without knowing about each
other. A client *subscribes* to a topic (e.g. `system-alerts`); another client
*publishes* a message to that topic; the broker instantly *fans the message out* to
every subscriber. The twist is the plumbing: instead of TCP + a framing protocol
like most brokers (Redis, MQTT, NATS), Quiver speaks **QUIC** directly. That buys
encrypted-by-default transport (TLS 1.3 is built into QUIC), independent streams
with no head-of-line blocking, fast `0-RTT` reconnects, and connection survival
across IP changes. Identity is cryptographic: each node's TLS certificate *is* its
public key, so two peers can verify exactly who they're talking to with zero shared
secrets.

---

## 2. Where this code came from (provenance)

Quiver's transport layer was **extracted from a production blockchain networking
stack** — the JAM protocol implementation (`tessers2`, `jam/network/`). That stack
ran a peer-to-peer QUIC mesh between blockchain validators. The engineering work in
Quiver was to **separate the genuinely reusable transport from the blockchain-specific
logic**, cut cleanly along that seam, and then build a brand-new application on top.

| Concern | In JAM (`jam/network/`) | In Quiver |
|---|---|---|
| QUIC node, one UDP socket, dual client/server role | `node.py` `QuicNode` (413 lines) | `transport/node.py` — **kept**, minus validator topology |
| Per-connection stream handling | `connection.py` `NodeConnection` | `transport/connection.py` `PeerConnection` — **generalized** (dropped the dedicated up0 stream; added `send`/`send_and_close`/`request`) |
| Ed25519 identity in cert SAN | `base/certificate.py` | `transport/certificate.py` — **kept verbatim in spirit** |
| 0-RTT session tickets | `base/sessions.py` | `transport/sessions.py` — **kept** |
| Protocol ABC + prefix registry | `base/protocol.py` (`tsrkit_types.Uint`, UP0 / CE128–CE201) | `transport/protocol.py` — **kept the ABC**, redefined prefixes as plain-int `PUBLISH`/`SUBSCRIBE`/`UNSUBSCRIBE` |
| Prefix → handler dispatch | `base/protocol_map.py` | `broker/router.py` `ProtocolRouter` |
| Node startup | `start.py` (reads `state.kappa/gamma/iota`, `set_neighbors()`) | folded into `transport/node.py` `start_node()` — **plain args, no chain state** |
| The ~20 validator protocols (`ce_128.py` … `up_0.py`) | block/shard/audit announcements | **fully replaced** by `broker/protocols/` (publish, subscribe, unsubscribe) |
| The entire pub/sub application + demo UI | — (didn't exist) | `broker/`, `run_client.py`, `ws_bridge.py`, `frontend/` — **100% original** |

**What was removed:** everything coupling transport to consensus — validator grid
topology, the √-grid neighbor selection, chain-state-driven reconnect, JAM telemetry,
and the `tsrkit_types` serialization library (Quiver uses plain `struct` big-endian
framing instead).

The takeaway for a reader: *recognizing which 400 lines of a production node are
generic transport vs. blockchain-specific, and cutting along that line, is the
core engineering story here.*

---

## 3. The three layers

```
┌──────────────────────────────────────────────────────────────────┐
│  APPLICATION   broker/        PubSubClient (run_client.py)         │
│                Broker         ws_bridge.py + frontend/ (React UI)  │
│  ── pub/sub semantics: topics, subscriptions, fan-out, ACKs ──    │
├──────────────────────────────────────────────────────────────────┤
│  PROTOCOL      broker/protocols/   ProtocolRouter   TopicRegistry  │
│  ── wire format: 1-byte prefix + length-framed payloads ──        │
├──────────────────────────────────────────────────────────────────┤
│  TRANSPORT     transport/     QuicNode · PeerConnection            │
│                certificate · sessions · protocol(ABC) · errors    │
│  ── QUIC: UDP, TLS 1.3, streams, connection-IDs, identity ──      │
└──────────────────────────────────────────────────────────────────┘
                              aioquic  (QUIC impl)
                              UDP socket
```

- **Transport (`transport/`)** — knows nothing about pub/sub. It moves bytes between
  authenticated peers over QUIC streams. Reusable for *any* QUIC application.
- **Protocol (`broker/protocols/` + `router.py` + `registry.py`)** — defines the
  three message types and how they're encoded/decoded on the wire, and routes each
  incoming stream to the right handler.
- **Application (`broker/broker.py`, `run_client.py`, `ws_bridge.py`, `frontend/`)** —
  the broker server, the CLI client, and the live web dashboard.

---

## 4. Core transport concepts

### 4.1 Why QUIC instead of TCP

QUIC runs over UDP but provides what TCP+TLS does, plus more:

- **Encryption is mandatory** — TLS 1.3 is part of the QUIC handshake, not bolted on.
- **Independent streams, no head-of-line blocking** — a lost packet on one stream
  doesn't stall the others. Each subscription and each publish can be its own stream.
- **0-RTT resumption** — a returning peer can send application data in its very first
  packet (see `transport/sessions.py`).
- **Connection survives network changes** — a connection is identified by a
  *Connection ID*, not the IP/port 4-tuple, so it survives the client roaming networks.

### 4.2 One socket, both roles — the dual-role node

`transport/node.py::QuicNode` is an `asyncio.DatagramProtocol` bound to **a single UDP
socket** that acts as **both server and client at the same time**:

- An incoming `INITIAL` packet from an unknown peer → a new **server-side**
  `PeerConnection` is created (`datagram_received`).
- Calling `node.connect(host, port)` → a new **client-side** `PeerConnection`.

This is the standard QUIC peer-to-peer pattern and is what makes a true mesh possible:
every node can both dial out and accept dials on the same port.

> **Notable detail:** aioquic servers don't request a client certificate by default.
> Quiver monkey-patches `QuicConnection._initialize` (top of `node.py`) to force
> `_request_client_certificate = True`, so the broker can verify *the client's*
> Ed25519 identity too — i.e. **mutual TLS (mTLS)**, not just server auth.

### 4.3 Connection-ID routing

QUIC connections are addressed by **Connection IDs (CIDs)**, and a single connection
rotates through *several* CIDs over its lifetime (for privacy / NAT rebinding). The
node keeps two maps:

- `_cid_map: {cid → PeerConnection}` — route every inbound datagram to its connection.
- `_peer_map: {ed25519_public → latest cid}` — answer "is this identity connected?"

The CID lifecycle callbacks (`_on_cid_issued`, `_on_cid_retired`, `_on_conn_terminated`)
keep these maps correct as CIDs come and go. This bookkeeping is the part most people
underestimate; it's why the node is the largest transport file.

### 4.4 Identity = the certificate (zero-trust, no CA)

`transport/certificate.py` is the heart of the security model:

1. Each node generates an **Ed25519** keypair (optionally from a deterministic 32-byte
   `seed`).
2. It builds a **self-signed** X.509 cert whose **Subject Alternative Name** is a
   deterministic encoding of the public key:
   `N(k) = "e" + base32_custom(little_endian_int(k))` → a 53-char DNS-safe string.
3. On every handshake, `verify_certificate()` recomputes the expected SAN from the
   presented public key and checks it matches, that the cert is in its validity window,
   and that the algorithm is Ed25519.

Because the SAN is *derived from* the key, the certificate is **cryptographically
bound** to the identity. No certificate authority, no passwords — a peer's identity is
simply its public key, and anyone can verify it independently. The verified key is
stored as `PeerConnection.ed25519_public` and becomes the peer's permanent ID.

### 4.5 Stream taxonomy: push (UP) vs request-response (CE)

Quiver inherits JAM's two stream styles (the names come from the JAM spec):

- **UP / push streams** — opened once and **kept open**; data flows continuously with
  no FIN. Used for **subscriptions**: the broker pushes every new message to the
  subscriber over the same long-lived stream.
- **CE / request-response streams** — send a request, set **FIN**, wait for one reply,
  done. Used for **publish** and **unsubscribe** (send → get an ACK).

`PeerConnection` exposes exactly three send primitives that map onto this:

| Method | Sets FIN? | Waits for reply? | Used by |
|---|---|---|---|
| `send(data, sid)` | no | no | broker pushing messages to subscribers |
| `send_and_close(data, sid)` | yes | no | broker ACKs, subscribe request |
| `request(data, sid)` | yes | **yes** | publish (await ACK), unsubscribe (await ACK) |

Incoming bytes are **buffered per-stream** in `PeerConnection._rx_buffer` and only
delivered to the application as a complete message when FIN arrives — except push
chunks, which are delivered immediately as they stream in.

---

## 5. The wire protocol

Everything routes on the **first byte** of a stream — the protocol prefix.

| Action | Prefix | Client → Broker | Broker → Client |
|---|---|---|---|
| **Publish** | `0x01` | `[0x01][4B topic_len][topic][4B msg_len][msg]` + FIN | `[0x00]` + FIN (ACK) / `[0x01]` + FIN (NACK) |
| **Subscribe** | `0x02` | `[0x02][4B topic_len][topic]` + FIN | *(stream stays open)* `[4B][0x00]` ACK, then `[4B msg_len][msg]` per message |
| **Unsubscribe** | `0x03` | `[0x03][4B topic_len][topic]` + FIN | `[0x00]` + FIN (ACK) |

All length fields are **big-endian unsigned 32-bit** (`struct.pack(">I", ...)`).
The encode/decode helpers live in `broker/protocols/base.py`:

- `encode_string` / `decode_string` — `[4B len][utf-8]`
- `encode_bytes` / `decode_bytes` — `[4B len][bytes]`
- `frame_push` / `decode_push_frames` — length-prefix framing so a subscriber can
  reassemble pushed messages that span multiple QUIC datagrams.

---

## 6. End-to-end walkthroughs

### 6.1 Subscribe (and how messages get pushed back)

```
CLIENT                                          BROKER
  │  open bidirectional stream S                  │
  │  send  [0x02][len][topic]  + FIN  ───────────▶│  QuicNode.on_data → ProtocolRouter
  │                                               │  prefix 0x02 → SubscribeProtocol
  │                                               │  registry.subscribe(topic, conn, S)
  │◀──────────  [4B][0x00]  (ACK, NO FIN) ────────│  conn.send(frame_push(ACK), S)
  │   stream S stays open  ───────────────────────│   (broker keeps its half open)
  │◀──────────  [4B msg_len][msg]  ───────────────│   ← future publishes pushed here
  │◀──────────  [4B msg_len][msg]  ───────────────│
```

The client FINs *its* half of stream `S`, but QUIC streams are bidirectional, so the
**broker keeps its half open** and pushes all future messages for `topic` back on the
same stream `S`. The client reassembles them with `decode_push_frames`.

### 6.2 Publish + fan-out

```
PUBLISHER                                       BROKER                         SUBSCRIBERS
  │ request([0x01][topic][msg], S) ─────────────▶│ PublishProtocol.req_intercept
  │   (send + FIN, await reply)                  │ registry.push(topic, msg):
  │                                              │   frame_push(msg)
  │                                              │   for each Subscriber(conn, sid):
  │                                              │     conn.send(framed, sid) ──────▶│ (push stream)
  │◀──────────────  [0x00] + FIN  (ACK) ─────────│ conn.send_and_close(ACK, S)       │
  │  request() future resolves → True            │                                   │
```

`TopicRegistry.push` is the fan-out engine. It iterates the topic's subscriber set,
sends the framed message on each subscriber's push stream, counts deliveries, and
**self-heals**: any subscriber whose `send` raises (dead connection) is collected and
removed from both indexes during the same pass.

### 6.3 Unsubscribe / disconnect cleanup

`TopicRegistry` keeps subscriptions **double-indexed** for O(1) cleanup from either
direction:

- `_by_topic: {topic → set[Subscriber]}` — drives fan-out.
- `_by_stream: {(id(conn), stream_id) → topic}` — reverse index.

So an explicit `UNSUBSCRIBE` (by topic) and an abrupt disconnect (`unsubscribe_all`
by connection, triggered from `QuicNode._on_conn_terminated` → `Broker._on_connection_lost`)
are both cheap and leave no dangling state.

---

## 7. Component reference

**Transport (`transport/`)**
- `node.py` — `QuicNode` + `start_node()`. UDP socket, accepts/dials connections,
  CID routing, version negotiation, optional QUIC Retry (address validation),
  keep-alive pings, the aioquic client-cert patch.
- `connection.py` — `PeerConnection`. Per-connection handler: handshake + cert
  verification, per-stream rx buffering, the `send`/`send_and_close`/`request` API,
  the single `on_data` callback the app layer hooks into.
- `certificate.py` — Ed25519 keygen, SAN encoding, cert build + verify.
- `sessions.py` — `SessionTicketStore` for 0-RTT resumption.
- `protocol.py` — `NetworkProtocol` ABC + `PrefixType` registry.
- `errors.py` — transport exception types.

**Broker (`broker/`)**
- `broker.py` — `Broker`. Wires `QuicNode` + `ProtocolRouter` + `TopicRegistry`;
  registers the three protocol handlers; lifecycle (`start`/`stop`); a
  `publish_local()` shortcut for injecting messages without a network round-trip.
- `router.py` — `ProtocolRouter`. First-byte → handler dispatch; ignores push chunks.
- `registry.py` — `TopicRegistry`. Subscription store + fan-out (section 6).
- `protocols/base.py` — wire encode/decode helpers.
- `protocols/{publish,subscribe,unsubscribe}.py` — the three handlers.

**Application / demo**
- `run_broker.py` — CLI entry point for the broker.
- `run_client.py` — `PubSubClient` + a `sub` / `pub` / `interactive` CLI.
- `ws_bridge.py` — runs the broker **and** an `aiohttp` WebSocket server on `:8080`.
  It *monkey-patches* `TopicRegistry` and `PeerConnection` to observe subscribe /
  publish / connect events and broadcasts them as JSON to the browser. Browser
  publishes arrive over WebSocket and are injected via `broker.publish_local`.
- `frontend/` — a React + TypeScript + Vite + Tailwind dashboard: live peer topology
  graph, message feed, throughput stats, and a publish form (`src/App.tsx`,
  `useWebSocket.ts`, `TopologyGraph.tsx`, …).

---

## 8. Running it

```bash
# 1. Broker
python run_broker.py -v                         # listens on 0.0.0.0:4433 (UDP)

# 2. Subscriber (separate terminal)
python run_client.py sub system-alerts

# 3. Publisher (third terminal)
python run_client.py pub system-alerts "Deploy completed successfully"

# Live web dashboard instead of CLI:
python ws_bridge.py                              # QUIC :4433 + WebSocket :8080
cd frontend && npm install && npm run dev        # open the Vite dev URL
```

Keys (`cert.pem`, `key.pem`, `pub_key.pem`) are generated automatically into
`keys/broker` / `keys/client` on first run.

---

## 9. Known limitations & roadmap (what's left to build)

These are honest gaps — useful both for planning and for talking about the project
candidly in an interview.

1. **Client stream→topic demux is naive.** `PubSubClient._on_data` delivers every
   pushed frame to *all* subscribed topic queues (it doesn't map a push stream back to
   its specific topic). A single client subscribed to two topics would mix their
   messages. *Fix:* track `stream_id → topic` at subscribe time and route per stream.
   (The `stream_id+1` comment in `run_client.py` is stale — the broker pushes on the
   **same** stream the subscribe came in on.)
2. **No authorization.** Identity is *authenticated* (mTLS), but any authenticated peer
   may publish or subscribe to any topic. *Next:* per-topic ACLs keyed on the peer's
   Ed25519 public key.
3. **No persistence / replay / retained messages.** Fan-out is live-only; a message
   published with no current subscribers is dropped. *Next:* optional retained-last or
   bounded per-topic ring buffer.
4. **No QoS / delivery guarantees.** Push is best-effort fire-and-forget; there's no
   per-message ack from subscriber back to broker, and no backpressure on a slow
   consumer (an unbounded send could grow memory).
5. **No wildcard / hierarchical topics** (e.g. `sensors/*`). Topics are exact-match.
6. **No client reconnect logic.** JAM had state-driven reconnect; it was removed during
   extraction and not yet replaced with a generic backoff reconnect.
7. **Automated tests are thin/absent.** A protocol-level test suite (encode/decode,
   fan-out, disconnect cleanup) would harden the wire format.
8. **`broker_id` in `ws_bridge.py` is a placeholder.** Should surface the broker's real
   Ed25519 identity.

---

## 10. Glossary

- **QUIC** — UDP-based transport with built-in TLS 1.3; the basis of HTTP/3.
- **CID (Connection ID)** — QUIC's connection identifier; rotates over a connection's life.
- **SAN** — Subject Alternative Name, an X.509 cert field; here it encodes the public key.
- **mTLS** — mutual TLS; both sides present and verify certificates.
- **0-RTT** — sending application data in the first packet of a resumed connection.
- **Fan-out** — delivering one published message to many subscribers.
- **UP / CE stream** — push (persistent) vs request-response (one reply, then FIN);
  terminology inherited from the JAM networking spec.
</content>
</invoke>
