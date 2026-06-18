"""
ws_bridge.py — WebSocket bridge for the Quiver frontend.

Run:  python ws_bridge.py

Starts the QUIC broker on 0.0.0.0:4433 AND a WebSocket server on
0.0.0.0:8080/ws.  The browser connects to ws://localhost:8080/ws.
"""
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Optional

from aiohttp import web
import aiohttp

from broker.broker import Broker
from broker.registry import TopicRegistry
from transport.connection import PeerConnection

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ws_bridge")

# ── Global state tracked by the bridge ────────────────────────────────────────

_clients: set[web.WebSocketResponse] = set()

_peers: dict[str, dict] = {}
# peer_id (hex) → { "peer_id", "connected_at", "subscriptions": [topic, ...] }

_topics: dict[str, set[str]] = {}
# topic → set of peer_ids subscribed

_msg_count = 0
_msg_timestamps: list[float] = []  # rolling window for msg/sec

_broker: Optional[Broker] = None
_main_loop: Optional[asyncio.AbstractEventLoop] = None


# ── Broadcast helpers ──────────────────────────────────────────────────────────

async def _broadcast(event: dict) -> None:
    if not _clients:
        return
    text = json.dumps(event)
    dead = set()
    for ws in _clients:
        try:
            await ws.send_str(text)
        except Exception:
            dead.add(ws)
    _clients.difference_update(dead)


def _schedule(coro) -> None:
    """Schedule a coroutine onto the main event loop from any context."""
    loop = _main_loop
    if loop is None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
    loop.create_task(coro)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _msg_per_sec() -> float:
    cutoff = time.monotonic() - 5.0
    while _msg_timestamps and _msg_timestamps[0] < cutoff:
        _msg_timestamps.pop(0)
    return round(len(_msg_timestamps) / 5.0, 2)


def _initial_state(broker_id: str) -> dict:
    return {
        "type": "initial_state",
        "broker_id": broker_id,
        "peers": [
            {
                "peer_id": p["peer_id"],
                "connected_at": p["connected_at"],
                "subscriptions": p["subscriptions"],
            }
            for p in _peers.values()
        ],
        "topics": [
            {"topic": t, "subscriber_count": len(subs)}
            for t, subs in _topics.items()
        ],
        "message_count": _msg_count,
    }


# ── Monkey-patch TopicRegistry to observe events ──────────────────────────────

_orig_subscribe = TopicRegistry.subscribe
_orig_unsubscribe = TopicRegistry.unsubscribe
_orig_unsub_all = TopicRegistry.unsubscribe_all
_orig_push = TopicRegistry.push


def _patched_subscribe(self, topic: str, conn: PeerConnection, stream_id: int) -> None:
    _orig_subscribe(self, topic, conn, stream_id)
    peer_id = conn.ed25519_public.hex() if conn.ed25519_public else conn.peer_id
    if peer_id not in _peers:
        _peers[peer_id] = {"peer_id": peer_id, "connected_at": _now(), "subscriptions": []}
    if topic not in _peers[peer_id]["subscriptions"]:
        _peers[peer_id]["subscriptions"].append(topic)
    _topics.setdefault(topic, set()).add(peer_id)
    _schedule(_broadcast({
        "type": "subscribed",
        "peer_id": peer_id,
        "topic": topic,
        "ts": _now(),
    }))


def _patched_unsubscribe(self, topic: str, conn: PeerConnection):
    result = _orig_unsubscribe(self, topic, conn)
    peer_id = conn.ed25519_public.hex() if conn.ed25519_public else conn.peer_id
    if peer_id in _peers and topic in _peers[peer_id]["subscriptions"]:
        _peers[peer_id]["subscriptions"].remove(topic)
    if topic in _topics:
        _topics[topic].discard(peer_id)
        if not _topics[topic]:
            del _topics[topic]
    _schedule(_broadcast({
        "type": "unsubscribed",
        "peer_id": peer_id,
        "topic": topic,
        "ts": _now(),
    }))
    return result


def _patched_unsubscribe_all(self, conn: PeerConnection) -> None:
    peer_id = conn.ed25519_public.hex() if conn.ed25519_public else conn.peer_id
    _orig_unsub_all(self, conn)
    if peer_id in _peers:
        del _peers[peer_id]
    for subs in _topics.values():
        subs.discard(peer_id)
    for t in [t for t, s in _topics.items() if not s]:
        del _topics[t]
    _schedule(_broadcast({
        "type": "peer_disconnected",
        "peer_id": peer_id,
        "ts": _now(),
    }))


def _patched_push(self, topic: str, message: bytes) -> int:
    global _msg_count
    result = _orig_push(self, topic, message)
    _msg_count += 1
    _msg_timestamps.append(time.monotonic())
    subscribers = list(_topics.get(topic, set()))
    _schedule(_broadcast({
        "type": "message",
        "topic": topic,
        "payload": message.decode("utf-8", errors="replace"),
        "ts": _now(),
        "subscribers": subscribers,
        "delivered": result,
    }))
    return result


TopicRegistry.subscribe = _patched_subscribe
TopicRegistry.unsubscribe = _patched_unsubscribe
TopicRegistry.unsubscribe_all = _patched_unsubscribe_all
TopicRegistry.push = _patched_push


# ── Monkey-patch PeerConnection to observe connect events ─────────────────────

_orig_handle_handshake = PeerConnection._handle_handshake


def _patched_handle_handshake(self, event):
    _orig_handle_handshake(self, event)
    if self.ed25519_public:
        peer_id = self.ed25519_public.hex()
        if peer_id not in _peers:
            _peers[peer_id] = {"peer_id": peer_id, "connected_at": _now(), "subscriptions": []}
            _schedule(_broadcast({
                "type": "peer_connected",
                "peer_id": peer_id,
                "connected_at": _peers[peer_id]["connected_at"],
                "ts": _now(),
            }))


PeerConnection._handle_handshake = _patched_handle_handshake


# ── Stats background task ─────────────────────────────────────────────────────

async def _stats_loop() -> None:
    while True:
        await asyncio.sleep(1)
        if _clients:
            await _broadcast({
                "type": "stats",
                "peer_count": len(_peers),
                "topic_count": len(_topics),
                "msg_per_sec": _msg_per_sec(),
                "total_messages": _msg_count,
            })


# ── WebSocket handler ─────────────────────────────────────────────────────────

async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    _clients.add(ws)
    logger.info("Browser connected")

    broker_id = "quiver-broker-0000000000000000"
    if _broker and _broker._node:
        try:
            import os
            cert_path = "keys/broker/cert.pem"
            if os.path.exists(cert_path):
                broker_id = "quiver-broker"
        except Exception:
            pass
    await ws.send_str(json.dumps(_initial_state(broker_id)))

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    if data.get("type") == "publish" and _broker:
                        topic = str(data.get("topic", ""))
                        message = str(data.get("message", ""))
                        if topic and message:
                            _broker.publish_local(topic, message.encode())
                except Exception as e:
                    logger.warning(f"Bad WS message: {e}")
            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break
    finally:
        _clients.discard(ws)
        logger.info("Browser disconnected")

    return ws


# ── Main ──────────────────────────────────────────────────────────────────────

@web.middleware
async def cors_middleware(request, handler):
    if request.method == "OPTIONS":
        return web.Response(headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        })
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


async def main() -> None:
    global _broker, _main_loop
    _main_loop = asyncio.get_running_loop()

    _broker = Broker()
    await _broker.start(host="0.0.0.0", port=4433, key_dir="keys/broker")
    logger.info("QUIC broker started on 0.0.0.0:4433")

    asyncio.create_task(_stats_loop())

    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/ws", ws_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    logger.info("WebSocket bridge listening on ws://0.0.0.0:8080/ws")

    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
