"""
SUBSCRIBE protocol.

The client sends a subscribe request and the broker registers it as a
subscriber for that topic.  The broker sends a 1-byte ACK and then keeps
the stream open — all future messages published to the topic are pushed
on this same stream without closing it.

Wire format  (client → broker):
    [0x02]          1B   prefix byte
    [4B]                 topic byte-length  (big-endian u32)
    [topic]              UTF-8 topic string
    <FIN>                client closes its half of the stream

Wire format  (broker → client, NO FIN — stream stays open):
    [0x00]          1B   ACK — subscribed

Subsequent pushed messages  (broker → client, no FIN each):
    [4B]                 message byte-length
    [message]            raw message bytes

The client accumulates these length-prefixed frames using
broker.protocols.base.decode_push_frames().
"""

import logging
from typing import TYPE_CHECKING

from transport.protocol import NetworkProtocol, PrefixType
from .base import decode_string, frame_push

if TYPE_CHECKING:
    from transport.connection import PeerConnection
    from broker.registry import TopicRegistry

logger = logging.getLogger(__name__)

_ACK = bytes([0x00])


class SubscribeProtocol(NetworkProtocol):
    """Handles incoming SUBSCRIBE requests on the broker side."""

    prefix = PrefixType.SUBSCRIBE  # 0x02

    def __init__(self, registry: "TopicRegistry") -> None:
        self._registry = registry

    async def transmit(self, data, conn: "PeerConnection") -> None:
        raise NotImplementedError("Use PubSubClient.subscribe() on the client side")

    def req_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        """
        Decode the SUBSCRIBE request, register the subscriber, send ACK.

        The stream is NOT closed after the ACK — the broker will push messages
        on it as they arrive.
        """
        try:
            topic, _ = decode_string(data, offset=1)  # skip prefix byte

            logger.info(
                f"SUBSCRIBE  topic={topic!r}  from={conn.peer_id}  stream={stream_id}"
            )

            self._registry.subscribe(topic, conn, stream_id)

            # ACK without FIN — length-framed so it's consistent with push messages.
            # The client decodes this as the first frame on the push stream: b'\x00' = subscribed.
            conn.send(frame_push(_ACK), stream_id)

        except Exception as e:
            logger.error(f"SUBSCRIBE  error: {e}")

    def res_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        raise NotImplementedError("Not used on the broker side")
