"""
UNSUBSCRIBE protocol — CE (request-response) style.

The client cancels its subscription to a topic.  The broker removes the
subscriber from the registry and closes the associated push stream.

Wire format  (client → broker):
    [0x03]          1B   prefix byte
    [4B]                 topic byte-length  (big-endian u32)
    [topic]              UTF-8 topic string
    <FIN>

Wire format  (broker → client):
    [0x00]          1B   ACK — unsubscribed
    <FIN>
"""

import logging
from typing import TYPE_CHECKING

from transport.protocol import NetworkProtocol, PrefixType
from .base import decode_string

if TYPE_CHECKING:
    from transport.connection import PeerConnection
    from broker.registry import TopicRegistry

logger = logging.getLogger(__name__)

_ACK = bytes([0x00])


class UnsubscribeProtocol(NetworkProtocol):
    """Handles incoming UNSUBSCRIBE requests on the broker side."""

    prefix = PrefixType.UNSUBSCRIBE  # 0x03

    def __init__(self, registry: "TopicRegistry") -> None:
        self._registry = registry

    async def transmit(self, data, conn: "PeerConnection") -> None:
        raise NotImplementedError("Use PubSubClient.unsubscribe() on the client side")

    def req_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        """
        Decode the UNSUBSCRIBE request, remove the subscriber, send ACK.
        The push stream for this topic is also closed (FIN sent by broker).
        """
        try:
            topic, _ = decode_string(data, offset=1)  # skip prefix byte

            logger.info(
                f"UNSUBSCRIBE  topic={topic!r}  from={conn.peer_id}"
            )

            # Remove from registry and close the push stream
            push_stream_id = self._registry.unsubscribe(topic, conn)
            if push_stream_id is not None:
                # Close the broker's half of the push stream
                conn.send_and_close(b"", push_stream_id)

            conn.send_and_close(_ACK, stream_id)

        except Exception as e:
            logger.error(f"UNSUBSCRIBE  error: {e}")

    def res_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        raise NotImplementedError("Not used on the broker side")
