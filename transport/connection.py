"""
PeerConnection — per-connection QUIC protocol handler.

Sits on top of aioquic's QuicConnectionProtocol and adds:
  - Automatic Ed25519 certificate verification on handshake
  - Stream data buffering
  - Three send modes:
      send()           → push data without closing the stream  (UP / push streams)
      send_and_close() → send data + FIN                       (CE one-way)
      request()        → send + FIN, then await the response   (CE request-response)
  - A single on_data callback that the application layer hooks into
"""

import asyncio
import logging
from typing import Callable, Dict, Optional

from aioquic.asyncio.protocol import QuicConnectionProtocol, QuicStreamHandler
from aioquic.quic.connection import QuicConnection
from aioquic.quic.events import (
    HandshakeCompleted,
    QuicEvent,
    StopSendingReceived,
    StreamDataReceived,
    StreamReset,
)

from .certificate import verify_certificate
from .errors import ConnectionClosedError, HandshakeError

logger = logging.getLogger(__name__)

# Called for every incoming data chunk.
#   stream_id  — which QUIC stream the data arrived on
#   data       — the raw bytes received in this chunk
#   end_stream — True if this is the last chunk on the stream (FIN received)
#   conn       — the PeerConnection it arrived on
DataCallback = Callable[[int, bytes, bool, "PeerConnection"], None]


class PeerConnection(QuicConnectionProtocol):
    """
    Generic QUIC connection handler.

    The application layer (broker, client, …) plugs in via `on_data`:

        def my_handler(stream_id, data, end_stream, conn):
            if end_stream:
                process_complete_message(data)
            else:
                handle_push_chunk(data)

        conn = PeerConnection(quic=..., is_initiating=True, on_data=my_handler)
    """

    #: 32-byte raw Ed25519 public key of the peer, set after handshake succeeds.
    ed25519_public: Optional[bytes]

    #: True if we (the local side) opened this connection.
    is_initiating: bool

    def __init__(
        self,
        quic: QuicConnection,
        is_initiating: bool,
        on_data: Optional[DataCallback] = None,
        stream_handler: Optional[QuicStreamHandler] = None,
    ) -> None:
        super().__init__(quic=quic, stream_handler=stream_handler)

        self.ed25519_public = None
        self.is_initiating = is_initiating
        self._on_data = on_data
        self._close_pending = False

        # Per-stream receive buffers  (stream_id → bytes)
        self._rx_buffer: Dict[int, bytes] = {}

        # Futures waiting for a response on a specific stream_id
        # (used by request())
        self._waiters: Dict[int, asyncio.Future] = {}

    # ------------------------------------------------------------------ #
    # Public send API
    # ------------------------------------------------------------------ #

    def send(self, data: bytes, stream_id: Optional[int] = None) -> int:
        """
        Push data on a stream without setting the FIN bit.

        Use this for persistent / push streams where the channel stays open
        and more data will arrive later (UP-style).

        Returns:
            The stream_id used (useful when stream_id was None and a new one
            was allocated).
        """
        if self._close_pending:
            raise ConnectionClosedError("Connection is closing.")

        if stream_id is None:
            stream_id = self._quic.get_next_available_stream_id()

        logger.debug(f"→ send {len(data)}B on stream {stream_id}")
        self._quic.send_stream_data(stream_id, data, end_stream=False)
        self.transmit()
        return stream_id

    def send_and_close(self, data: bytes, stream_id: int) -> None:
        """
        Send data and set the FIN bit, signalling the stream is done.

        Use this when you want to send a message without waiting for a reply
        (fire-and-forget CE-style).
        """
        if self._close_pending:
            raise ConnectionClosedError("Connection is closing.")

        logger.debug(f"→ send+close {len(data)}B on stream {stream_id}")
        self._quic.send_stream_data(stream_id, data, end_stream=True)
        self.transmit()

    async def request(self, data: bytes, stream_id: int) -> Optional[bytes]:
        """
        Send data + FIN on `stream_id`, then wait for the peer's response on
        the same stream.

        Use this for request-response exchanges (CE-style):
            stream_id = conn.send(prefix)       # open the stream + send prefix
            response  = await conn.request(     # send the body and wait
                payload, stream_id
            )

        Returns:
            The raw bytes of the peer's response, or None on error.
        """
        if self._close_pending:
            raise ConnectionClosedError("Connection is closing.")

        waiter: asyncio.Future = self._loop.create_future()
        self._waiters[stream_id] = waiter

        logger.debug(f"→ request {len(data)}B on stream {stream_id}, waiting for response")
        self._quic.send_stream_data(stream_id, data, end_stream=True)
        self.transmit()

        return await asyncio.shield(waiter)

    # ------------------------------------------------------------------ #
    # QUIC event handling
    # ------------------------------------------------------------------ #

    def quic_event_received(self, event: QuicEvent) -> None:
        try:
            if isinstance(event, HandshakeCompleted):
                self._handle_handshake(event)

            elif isinstance(event, StreamDataReceived):
                self._handle_stream_data(event)

            elif isinstance(event, (StreamReset, StopSendingReceived)):
                sid = event.stream_id
                self._rx_buffer.pop(sid, None)
                waiter = self._waiters.pop(sid, None)
                if waiter and not waiter.done():
                    waiter.set_exception(ConnectionError(f"Stream {sid} reset by peer"))
                logger.debug(f"Stream {sid} reset")

        except Exception:
            logger.exception("Unhandled error in quic_event_received")

    def _handle_handshake(self, event: HandshakeCompleted) -> None:
        try:
            peer_cert = self._quic.tls._peer_certificate
            if not peer_cert:
                raise HandshakeError("No peer certificate present in TLS handshake.")

            valid, err = verify_certificate(peer_cert)
            if not valid:
                raise HandshakeError(f"Peer certificate invalid: {err}")

            self.ed25519_public = peer_cert.public_key().public_bytes_raw()
            logger.info(f"Handshake complete — peer={self.peer_id}")

        except Exception as e:
            logger.error(f"Handshake failed: {e}")
            self._quic.close(error_code=0xA, reason_phrase=str(e))

    def _handle_stream_data(self, event: StreamDataReceived) -> None:
        sid = event.stream_id
        data = event.data
        end = event.end_stream

        # Guard: don't process data before we know who the peer is
        if not self.ed25519_public:
            peer_cert = self._quic.tls._peer_certificate
            if peer_cert:
                self._handle_handshake(HandshakeCompleted(
                    alpn_protocol=None,
                    early_data_accepted=False,
                    session_resumed=False,
                ))
            if not self.ed25519_public:
                logger.warning(f"Data on stream {sid} before handshake — dropped")
                return

        # Buffer incoming bytes
        self._rx_buffer.setdefault(sid, b"")
        self._rx_buffer[sid] += data

        logger.debug(f"← recv {len(data)}B on stream {sid}, end={end}, "
                     f"total_buffered={len(self._rx_buffer[sid])}B")

        if not end:
            # Push / streaming chunk — deliver immediately to the app layer
            if self._on_data:
                self._on_data(sid, data, False, self)
            return

        # Stream complete — deliver full buffer
        full = self._rx_buffer.pop(sid, b"")

        # Check if this is a response to a pending request()
        waiter = self._waiters.pop(sid, None)
        if waiter and not waiter.done():
            waiter.set_result(full)
            return

        # Deliver to application handler
        if self._on_data:
            self._on_data(sid, full, True, self)
        else:
            logger.warning(f"No on_data handler — {len(full)}B on stream {sid} dropped")

    # ------------------------------------------------------------------ #
    # Helpers / properties
    # ------------------------------------------------------------------ #

    @property
    def peer_id(self) -> Optional[str]:
        """Short human-readable peer identity."""
        if self.ed25519_public:
            return self.ed25519_public.hex()[:16] + "..."
        return "<unauthenticated>"

    def __repr__(self) -> str:
        return f"PeerConnection(peer={self.peer_id}, initiating={self.is_initiating})"
