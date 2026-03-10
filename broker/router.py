"""
ProtocolRouter — maps 1-byte prefix → protocol handler.

The broker registers one handler per prefix.  When data arrives on any
stream, the router reads the first byte, finds the matching handler,
and calls handler.req_intercept().

Only complete messages (end_stream=True) are routed.  Intermediate chunks
(end_stream=False) are ignored here — connection.py already accumulates
them and only delivers the full buffer when the FIN arrives.
"""

import logging
from typing import Dict, TYPE_CHECKING

from transport.protocol import NetworkProtocol

if TYPE_CHECKING:
    from transport.connection import PeerConnection

logger = logging.getLogger(__name__)


class ProtocolRouter:
    """Routes incoming complete stream messages to their protocol handlers."""

    def __init__(self) -> None:
        self._handlers: Dict[int, NetworkProtocol] = {}

    def register(self, prefix: int, handler: NetworkProtocol) -> None:
        """Register a handler for a given prefix byte."""
        self._handlers[prefix] = handler
        logger.debug(
            f"Registered {type(handler).__name__} for prefix {prefix:#04x}"
        )

    def route(
        self,
        stream_id: int,
        data: bytes,
        end_stream: bool,
        conn: "PeerConnection",
    ) -> None:
        """
        Called for every incoming data event.

        Ignores push chunks (end_stream=False) — those are subscription
        delivery streams going the other direction (broker → client) and
        don't need to be routed on the broker side.

        For complete messages (end_stream=True), reads the prefix byte and
        dispatches to the matching protocol handler.
        """
        if not end_stream or not data:
            return

        prefix = data[0]
        handler = self._handlers.get(prefix)

        if handler is None:
            logger.warning(
                f"Unknown protocol prefix {prefix:#04x} on stream {stream_id} "
                f"from {conn.peer_id} — dropping"
            )
            return

        try:
            logger.debug(
                f"Routing prefix={prefix:#04x} → {type(handler).__name__}  "
                f"stream={stream_id}  size={len(data)}B"
            )
            handler.req_intercept(stream_id, data, conn)
        except Exception:
            logger.exception(
                f"Unhandled error in {type(handler).__name__}.req_intercept "
                f"(prefix={prefix:#04x}, stream={stream_id})"
            )
