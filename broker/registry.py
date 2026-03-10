"""
TopicRegistry — the subscription store.

Maps topic names to the set of (connection, stream_id) pairs that have
subscribed to them.  Also handles fan-out when a message is published.

Thread-safety: designed for single-threaded asyncio use only.
"""

import logging
from dataclasses import dataclass
from typing import Dict, Optional, Set, Tuple

from transport.connection import PeerConnection
from transport.errors import ConnectionClosedError
from .protocols.base import frame_push

logger = logging.getLogger(__name__)


@dataclass
class Subscriber:
    """A single subscription: one connection subscribed to one topic."""
    conn: PeerConnection
    stream_id: int

    # Make it hashable so we can put it in a set
    def __hash__(self) -> int:
        return hash((id(self.conn), self.stream_id))

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Subscriber)
            and self.conn is other.conn
            and self.stream_id == other.stream_id
        )


class TopicRegistry:
    """
    Stores all active subscriptions and handles message fan-out.

    Subscriptions are indexed two ways for efficient lookup:
      topic  → set of Subscriber          (for fan-out on PUBLISH)
      (conn_id, stream_id) → topic        (for cleanup on UNSUBSCRIBE / disconnect)
    """

    def __init__(self) -> None:
        # topic → set of active subscribers
        self._by_topic: Dict[str, Set[Subscriber]] = {}
        # (id(conn), stream_id) → topic  — reverse index for O(1) unsubscribe
        self._by_stream: Dict[Tuple[int, int], str] = {}

    # ------------------------------------------------------------------ #
    # Subscribe / unsubscribe
    # ------------------------------------------------------------------ #

    def subscribe(self, topic: str, conn: PeerConnection, stream_id: int) -> None:
        """Register `conn` as a subscriber for `topic` on `stream_id`."""
        sub = Subscriber(conn=conn, stream_id=stream_id)
        self._by_topic.setdefault(topic, set()).add(sub)
        self._by_stream[(id(conn), stream_id)] = topic
        logger.info(
            f"+ subscribed  topic={topic!r}  peer={conn.peer_id}  stream={stream_id}  "
            f"total={len(self._by_topic[topic])}"
        )

    def unsubscribe(self, topic: str, conn: PeerConnection) -> Optional[int]:
        """
        Remove all subscriptions of `conn` to `topic`.

        Returns:
            The stream_id that was used for this subscription (so the broker
            can close its end of the push stream), or None if not found.
        """
        subs = self._by_topic.get(topic, set())
        matches = {s for s in subs if s.conn is conn}
        if not matches:
            logger.debug(f"unsubscribe: {conn.peer_id} was not subscribed to {topic!r}")
            return None

        stream_id = next(iter(matches)).stream_id
        for sub in matches:
            subs.discard(sub)
            self._by_stream.pop((id(conn), sub.stream_id), None)

        if not subs:
            del self._by_topic[topic]

        logger.info(f"- unsubscribed  topic={topic!r}  peer={conn.peer_id}")
        return stream_id

    def unsubscribe_all(self, conn: PeerConnection) -> None:
        """
        Remove every subscription held by `conn`.

        Called when a connection is lost so we don't push to dead peers.
        """
        dead_keys = [key for key in self._by_stream if key[0] == id(conn)]
        for key in dead_keys:
            topic = self._by_stream.pop(key)
            subs = self._by_topic.get(topic, set())
            subs.discard(Subscriber(conn=conn, stream_id=key[1]))
            if not subs:
                self._by_topic.pop(topic, None)

        if dead_keys:
            logger.info(
                f"cleaned up {len(dead_keys)} subscription(s) for lost peer {conn.peer_id}"
            )

    # ------------------------------------------------------------------ #
    # Fan-out
    # ------------------------------------------------------------------ #

    def push(self, topic: str, message: bytes) -> int:
        """
        Push `message` to every subscriber of `topic`.

        Wraps the message in a length-prefix frame so the client can
        reassemble it from streaming chunks.

        Returns:
            Number of subscribers successfully reached.
        """
        subs = list(self._by_topic.get(topic, set()))
        if not subs:
            logger.debug(f"push: no subscribers for topic={topic!r}")
            return 0

        framed = frame_push(message)
        delivered = 0
        dead: list[Subscriber] = []

        for sub in subs:
            try:
                sub.conn.send(framed, sub.stream_id)
                delivered += 1
            except (ConnectionClosedError, ConnectionError, Exception) as e:
                logger.warning(
                    f"push failed for {sub.conn.peer_id} stream={sub.stream_id}: {e} — "
                    f"removing stale subscriber"
                )
                dead.append(sub)

        # Clean up stale subscribers discovered during fan-out
        for sub in dead:
            self._by_topic.get(topic, set()).discard(sub)
            self._by_stream.pop((id(sub.conn), sub.stream_id), None)

        logger.debug(
            f"push  topic={topic!r}  delivered={delivered}/{len(subs)}  "
            f"size={len(message)}B"
        )
        return delivered

    # ------------------------------------------------------------------ #
    # Introspection
    # ------------------------------------------------------------------ #

    @property
    def topics(self) -> list[str]:
        """All topics that currently have at least one subscriber."""
        return list(self._by_topic.keys())

    def subscriber_count(self, topic: str) -> int:
        """Number of active subscribers for `topic`."""
        return len(self._by_topic.get(topic, set()))

    def all_counts(self) -> Dict[str, int]:
        """Dict of {topic: subscriber_count} for all active topics."""
        return {t: len(subs) for t, subs in self._by_topic.items()}
