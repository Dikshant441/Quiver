"""
Base classes for application-layer protocols built on top of PeerConnection.

Every protocol:
  - Has a single-byte prefix that identifies it on the wire
  - Implements transmit() to send data to a peer
  - Implements req_intercept() to handle an incoming request
  - Implements res_intercept() to handle the peer's response

Wire format for CE (request-response) streams:
    [1B prefix][payload]
    <-- FIN
    [response payload]
    <-- FIN

Wire format for UP (push) streams:
    [1B prefix][length-prefixed messages...]
    (stream stays open)

The broker layer extends these base classes to define PUBLISH, SUBSCRIBE, etc.
"""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .connection import PeerConnection


class PrefixType:
    """
    Registry of 1-byte protocol prefixes.

    The first byte of every stream identifies which protocol handles it.
    Prefixes 0x00–0x7F are reserved for push (UP) streams.
    Prefixes 0x80–0xFF are for request-response (CE) streams.

    Add new protocol prefixes here as the broker grows.
    """

    # ── Push / UP streams (persistent, no FIN) ──────────────────────
    PUSH = 0x00   # Generic push stream (used by subscribe)

    # ── Request-Response / CE streams (FIN on both sides) ───────────
    PUBLISH     = 0x01   # Client → Broker: publish a message to a topic
    SUBSCRIBE   = 0x02   # Client → Broker: subscribe to a topic
    UNSUBSCRIBE = 0x03   # Client → Broker: unsubscribe from a topic
    ACK         = 0x04   # Broker → Client: acknowledge a publish


class NetworkProtocol(ABC):
    """
    Abstract base for a single application-layer protocol.

    Subclass this for each protocol (PUBLISH, SUBSCRIBE, …) and register it
    in the broker's ProtocolMap keyed by its prefix byte.

    Flow (CE / request-response):
        1. Initiator calls transmit() → sends prefix + payload + FIN
        2. Responder receives data → req_intercept() is called
        3. Responder sends response + FIN
        4. Initiator receives response → res_intercept() is called

    Flow (UP / push):
        1. Subscriber calls transmit() → sends prefix + FIN  (subscribe request)
        2. Broker calls req_intercept() → registers subscriber, opens push stream
        3. Broker pushes messages via conn.send() (no FIN, stream stays open)
    """

    #: Must be set by each subclass to the matching PrefixType value
    prefix: int

    @abstractmethod
    async def transmit(self, data: Any, conn: "PeerConnection") -> None:
        """
        Send this protocol's message to a peer.

        Called by the initiating side (client sending PUBLISH, broker pushing data, …).
        """
        ...

    @abstractmethod
    def req_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        """
        Process an incoming request on this protocol.

        Called when a complete message (or push chunk) arrives and the prefix
        byte matches this protocol's prefix.

        The implementation should:
          - Decode `data`
          - Do the work (store message, fan out to subscribers, …)
          - Send a response via conn.send_and_close() if applicable
        """
        ...

    @abstractmethod
    def res_intercept(self, stream_id: int, data: bytes, conn: "PeerConnection") -> None:
        """
        Process the peer's response to our request.

        Called on the initiating side after the responder sends its reply.
        """
        ...
