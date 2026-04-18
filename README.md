#Setowire - Javascript

A lightweight, portable P2P networking library built on UDP. No central servers, no brokers — peers find each other and communicate directly.

Built to be simple enough to reimplement in any language.

---

## Why

Most P2P libraries are either too heavy or too tied to a specific runtime. We wanted something small, auditable, and easy to port to Rust, Go, or whatever comes next. The protocol fits in your head.

---

## How it works

Peers discover each other through multiple strategies running in parallel — whichever works first wins:

- **DHT** — decentralized peer discovery by topic
- **Piping servers** — HTTPS rendezvous for peers behind strict NATs
- **LAN multicast** — instant discovery on local networks
- **HTTP bootstrap nodes** — fallback seed servers
- **Peer cache** — remembers peers from previous sessions

Once connected, all traffic is encrypted end-to-end with X25519 + ChaCha20-Poly1305. Peers that detect they have a full-cone NAT automatically become relays for others.

---

## File structure

```
constants.js   — all tuneable parameters and frame type definitions
crypto.js      — X25519 key exchange, ChaCha20-Poly1305 encrypt/decrypt
structs.js     — BloomFilter, LRU, RingBuffer, PayloadCache
framing.js     — packet fragmentation, jitter buffer, batch UDP sender
dht_lib.js     — minimal DHT for decentralized topic-based discovery
peer.js        — per-peer state: queues, congestion control, multipath
swarm.js       — main class: discovery, mesh, relay, sync, gossip
index.js       — entry point
chat.js        — example terminal chat app
```

---

## Quick start

```js
const Swarm  = require('./index');
const crypto = require('crypto');

const swarm = new Swarm();
const topic = crypto.createHash('sha256').update('my-topic').digest();

swarm.join(topic, { announce: true, lookup: true });

swarm.on('connection', (peer) => {
  peer.write(Buffer.from('hello'));
});

swarm.on('data', (data, peer) => {
  console.log('got:', data.toString());
});
```

---

## API

### `new Swarm(opts?)`

| option | default | description |
|---|---|---|
| `seed` | random | 32-byte hex string — deterministic identity |
| `maxPeers` | 100 | max simultaneous connections |
| `relay` | false | force relay mode regardless of NAT |
| `bootstrap` | [] | `["host:port"]` bootstrap nodes |
| `seeds` | [] | additional hardcoded seed peers |

### `swarm.join(topic, opts?)`

Start announcing and/or looking up peers on a topic. `topic` is a Buffer (usually a hash).

Returns `{ ready(), destroy() }`.

### `swarm.broadcast(data)`

Send data to all connected peers. Returns number of peers reached.

### `swarm.store(key, value)`

Store a value locally and announce it to the mesh.

### `swarm.fetch(key, timeout?)`

Fetch a value — returns local copy immediately or pulls from the network.

### `swarm.destroy()`

Graceful shutdown. Notifies peers and closes the socket.

### Events

| event | args | description |
|---|---|---|
| `connection` | `peer, info` | new peer connected |
| `data` | `data, peer` | message received |
| `disconnect` | `peerId` | peer dropped |
| `sync` | `key, value` | value received from network |
| `nat` | — | public address discovered |

---

## Protocol

The wire protocol is plain UDP. Each packet starts with a 1-byte frame type:

| byte | type | description |
|---|---|---|
| `0x01` | DATA | encrypted application data |
| `0x03` | PING | keepalive + RTT measurement |
| `0x04` | PONG | keepalive reply |
| `0x0A` | GOAWAY | graceful disconnect |
| `0x0B` | FRAG | fragment of a large message |
| `0x13` | BATCH | multiple frames in one datagram |
| `0x20` | RELAY_ANN | peer announcing itself as relay |
| `0x21` | RELAY_REQ | request introduction via relay |
| `0x22` | RELAY_FWD | relay forwarding an introduction |
| `0x30` | PEX | peer exchange |

Handshake is two frames: `0xA1` (hello) and `0xA2` (hello ack). Each carries the sender's ID and raw X25519 public key. After that, all data is encrypted.

---

## Porting to another language

The minimum you need to implement:

1. X25519 key exchange + HKDF-SHA256 to derive send/recv keys
2. ChaCha20-Poly1305 encrypt/decrypt with a 12-byte nonce (4-byte session ID + 8-byte counter)
3. The handshake frames (`0xA1` / `0xA2`)
4. DATA frame (`0x01`) with the encrypted payload
5. PING/PONG for keepalive

Everything else (DHT, relay, gossip, PEX) is optional and can be added incrementally.

The session key derivation label is `p2p-v12-session` — both sides must use the same label. The peer with the lexicographically lower ID uses the first 32 bytes as send key; the other peer flips them.

---

## Chat example

```bash
node chat.js <nick> [room]
node chat.js alice myroom
```

Commands: `/peers`, `/nat`, `/quit`

