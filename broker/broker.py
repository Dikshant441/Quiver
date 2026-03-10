"""
Broker — the pub/sub server.

Wires together:
  - QuicNode        (transport — QUIC connections, TLS, stream I/O)
  - ProtocolRouter  (routes prefix bytes to the right handler)
  - TopicRegistry   (tracks subscribers, fans out published messages)

Usage:
    broker = Broker()
    await broker.start(host="0.0.0.0", port=4433, key_dir="keys/broker")

    # Keep running until you're done
    await asyncio.Event().wait()   # or any other "run forever" idiom

    await broker.stop()
"""

import asyncio
import logging
from typing import Optional

from transport.node import QuicNode, start_node
from transport.connection import PeerConnection

from .registry import TopicRegistry
from .router import ProtocolRouter
from .protocols.publish import PublishProtocol
from .protocols.subscribe import SubscribeProtocol
from .protocols.unsubscribe import UnsubscribeProtocol

logger = logging.getLogger(__name__)


class Broker:
    """
    QUIC-native pub/sub broker.

    Accepts incoming QUIC connections from publishers and subscribers.
    Each connected peer authenticates via its Ed25519 certificate — no
    usernames, no passwords, just cryptographic identity.

    Supported operations (triggered by the peer's first stream byte):
        0x01  PUBLISH      → fan out message to all topic subscribers
        0x02  SUBSCRIBE    → register peer as a subscriber; push future messages
        0x03  UNSUBSCRIBE  → remove subscription, close push stream
    """

    def __init__(self) -> None:
        self._registry = TopicRegistry()
        self._router = ProtocolRouter()
        self._node: Optional[QuicNode] = None

        # Register all protocol handlers
        self._router.register(0x01, PublishProtocol(self._registry))
        self._router.register(0x02, SubscribeProtocol(self._registry))
        self._router.register(0x03, UnsubscribeProtocol(self._registry))

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    async def start(
        self,
        host: str = "0.0.0.0",
        port: int = 4433,
        key_dir: str = "keys/broker",
        seed: Optional[bytes] = None,
    ) -> None:
        """
        Start the broker: generate keys, bind UDP socket, begin accepting peers.

        Args:
            host:    Interface to bind on ("0.0.0.0" for all interfaces)
            port:    UDP port to listen on
            key_dir: Where to store the broker's Ed25519 cert and key
            seed:    Optional 32-byte seed for a deterministic identity
        """
        self._node = await start_node(
            host=host,
            port=port,
            key_dir=key_dir,
            on_data=self._on_data,
            on_connection_lost=self._on_connection_lost,
            seed=seed,
        )
        logger.info(f"Broker listening on {host}:{port}")

    async def stop(self) -> None:
        """Gracefully shut down the broker."""
        if self._node:
            self._node.close_all()
            self._node = None
        logger.info("Broker stopped")

    # ------------------------------------------------------------------ #
    # Programmatic API (for testing / embedding)
    # ------------------------------------------------------------------ #

    def publish_local(self, topic: str, message: bytes) -> int:
        """
        Publish a message without going over the network.

        Useful for injecting messages in tests or from the broker process itself.

        Returns:
            Number of subscribers that received the message.
        """
        return self._registry.push(topic, message)

    @property
    def topics(self) -> list[str]:
        """All topics that currently have at least one subscriber."""
        return self._registry.topics

    def subscriber_count(self, topic: str) -> int:
        return self._registry.subscriber_count(topic)

    def all_counts(self) -> dict:
        """Dict of {topic: subscriber_count} for all active topics."""
        return self._registry.all_counts()

    # ------------------------------------------------------------------ #
    # Internal callbacks — wired into QuicNode
    # ------------------------------------------------------------------ #

    def _on_data(
        self,
        stream_id: int,
        data: bytes,
        end_stream: bool,
        conn: PeerConnection,
    ) -> None:
        """Dispatched by QuicNode for every incoming stream data event."""
        self._router.route(stream_id, data, end_stream, conn)

    def _on_connection_lost(self, conn: PeerConnection) -> None:
        """Dispatched by QuicNode when a peer disconnects."""
        logger.info(f"Peer disconnected: {conn.peer_id}")
        self._registry.unsubscribe_all(conn)
