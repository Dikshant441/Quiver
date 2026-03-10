"""
PUBLISH protocol — CE (request-response) style.

A publisher sends a topic + message to the broker. The broker fans it out
to every registered subscriber for that topic, then sends an ACK back.

Wire format  (publisher → broker, stream stays open until FIN):
    [0x01]          1B   prefix byte
    [4B]                 topic byte-length  (big-endian u32)
    [topic]              UTF-8 topic string
    [4B]                 message byte-length
    [message]            raw message bytes
    <FIN>

Wire format  (broker → publisher, same stream_id):
    [0x00]          1B   ACK — success
    <FIN>

    — or —

    [0x01]          1B   NACK — error
    <FIN>
"""

import logging
from typing import TYPE_CHECKING

from transport.protocol import NetworkProtocol, PrefixType
from .base import decode_string, decode_bytes

if TYPE_CHECKING:
    from transport.connection import PeerConnection
    from broker.registry import TopicRegistry

logger = logging.getLogger(__name__)

_ACK  = bytes([0x00])
_NACK = bytes([0x01])


class PublishProtocol(NetworkProtocol):
    """Handles incoming PUBLISH requests on the broker side."""

    prefix = PrefixType.PUBLISH  # 0x01

    def __init__(self, registry: "TopicRegistry") -> None:
        self._registry = registry

    async def transmit(self, data, conn: "PeerConnection") -> None:
        raise NotImplementedError("Use PubSubClient.publish() on the client side")

    def req_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        """
        Decode the PUBLISH request, fan out to subscribers, send ACK.
        `data` is the complete buffered payload including the prefix byte.
        """
        try:
            topic,   offset = decode_string(data, offset=1)   # skip prefix byte
            message, _      = decode_bytes(data,  offset=offset)

            logger.info(
                f"PUBLISH  topic={topic!r}  size={len(message)}B  from={conn.peer_id}"
            )

            delivered = self._registry.push(topic, message)
            conn.send_and_close(_ACK, stream_id)

            logger.debug(f"PUBLISH  ack sent — delivered to {delivered} subscriber(s)")

        except Exception as e:
            logger.error(f"PUBLISH  error: {e}")
            conn.send_and_close(_NACK, stream_id)

    def res_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        """Called on the publisher side when the broker's ACK arrives."""
        if data and data[0] == 0x00:
            logger.debug(f"PUBLISH  ack received on stream {stream_id}")
        else:
            logger.warning(f"PUBLISH  nack on stream {stream_id}")
