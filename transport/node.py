"""
QuicNode — the QUIC transport layer entry point.

Acts as both a UDP server (accepts incoming connections) and a client
(initiates outgoing connections) — all on the same UDP socket.

This is the standard QUIC peer-to-peer pattern:
  - One bound UDP socket for everything
  - Incoming INITIAL packets create new server-side PeerConnections
  - connect() creates client-side PeerConnections

Usage:
    node = await start_node(host="0.0.0.0", port=4433, on_data=my_handler)
    conn = await node.connect("127.0.0.1", 5000)
    stream_id = conn.send(b"\\x01hello")
"""

import asyncio
import logging
import os
import ssl
import socket
from functools import partial
from typing import Callable, Dict, Optional, Set, cast

from aioquic._buffer import Buffer
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration, SMALLEST_MAX_DATAGRAM_SIZE
from aioquic.quic.connection import NetworkAddress, QuicConnection
from aioquic.quic.logger import QuicLogger
from aioquic.quic.packet import (
    QuicPacketType,
    encode_quic_retry,
    encode_quic_version_negotiation,
    pull_quic_header,
)
from aioquic.quic.retry import QuicRetryTokenHandler

from .certificate import generate_keys
from .connection import DataCallback, PeerConnection
from .sessions import SessionTicketStore
from .errors import TransportError

logger = logging.getLogger(__name__)

# ── Patch aioquic to request client certificates during TLS handshake ──────────
# By default aioquic servers don't request a client cert.
# We need it so we can verify the peer's Ed25519 identity.
_original_initialize = QuicConnection._initialize


def _patched_initialize(self, peer_cid: bytes) -> None:
    _original_initialize(self, peer_cid)
    self.tls._request_client_certificate = True


QuicConnection._initialize = _patched_initialize
# ───────────────────────────────────────────────────────────────────────────────


class QuicNode(asyncio.DatagramProtocol):
    """
    QUIC transport node — handles all incoming datagrams and manages
    the full lifecycle of every PeerConnection.

    Key responsibilities:
      - Route each incoming datagram to its PeerConnection (by connection ID)
      - Handle new incoming connections (INITIAL packets from unknown peers)
      - Track every active connection by connection ID and by peer identity
      - Provide connect() to initiate outgoing connections
      - Provide keep_alive() to maintain persistent connections
    """

    def __init__(
        self,
        cfg: QuicConfiguration,
        on_data: Optional[DataCallback] = None,
        on_connection_lost: Optional[Callable[["PeerConnection"], None]] = None,
        session_ticket_fetcher=None,
        session_ticket_handler=None,
        retry: bool = False,
    ) -> None:
        self._cfg = cfg
        self._on_data = on_data
        self._on_connection_lost = on_connection_lost
        self._session_ticket_fetcher = session_ticket_fetcher
        self._session_ticket_handler = session_ticket_handler
        self._retry = QuicRetryTokenHandler() if retry else None
        self._transport: Optional[asyncio.DatagramTransport] = None

        # Maps connection_id (bytes) → PeerConnection
        # A single PeerConnection may have multiple CIDs over its lifetime
        self._cid_map: Dict[bytes, PeerConnection] = {}

        # Maps ed25519_public (bytes) → latest connection_id (bytes)
        # Lets us look up "is this peer already connected?"
        self._peer_map: Dict[bytes, bytes] = {}

    # ------------------------------------------------------------------ #
    # asyncio.DatagramProtocol — called by the event loop
    # ------------------------------------------------------------------ #

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self._transport = cast(asyncio.DatagramTransport, transport)
        logger.info("QuicNode transport ready")

    def datagram_received(self, data, addr: NetworkAddress) -> None:
        data = cast(bytes, data)
        buf = Buffer(data=data)

        try:
            header = pull_quic_header(buf, host_cid_length=self._cfg.connection_id_length)
        except ValueError:
            logger.warning(f"Malformed QUIC packet from {addr}, dropping")
            return

        if not self._transport:
            return

        # ── Version negotiation ────────────────────────────────────────
        if (
            header.version is not None
            and header.version not in self._cfg.supported_versions
        ):
            self._transport.sendto(
                encode_quic_version_negotiation(
                    source_cid=header.destination_cid,
                    destination_cid=header.source_cid,
                    supported_versions=self._cfg.supported_versions,
                ),
                addr,
            )
            return

        # ── Route to existing connection ───────────────────────────────
        conn = self._cid_map.get(header.destination_cid)
        original_dcid: Optional[bytes] = None
        retry_source_cid: Optional[bytes] = None

        # ── New incoming connection (INITIAL packet from unknown peer) ──
        if (
            conn is None
            and len(data) >= SMALLEST_MAX_DATAGRAM_SIZE
            and header.packet_type == QuicPacketType.INITIAL
        ):
            if self._retry is not None:
                if not header.token:
                    # Challenge the client with a Retry packet
                    source_cid = os.urandom(8)
                    self._transport.sendto(
                        encode_quic_retry(
                            version=header.version,
                            source_cid=source_cid,
                            destination_cid=header.source_cid,
                            original_destination_cid=header.destination_cid,
                            retry_token=self._retry.create_token(
                                addr, header.destination_cid, source_cid
                            ),
                        ),
                        addr,
                    )
                    return
                else:
                    try:
                        original_dcid, retry_source_cid = self._retry.validate_token(
                            addr, header.token
                        )
                    except ValueError:
                        return
            else:
                original_dcid = header.destination_cid

            # Build server-side QUIC connection
            server_cfg = QuicConfiguration(**self._cfg.__dict__)
            server_cfg.is_client = False

            quic_conn = QuicConnection(
                configuration=server_cfg,
                original_destination_connection_id=original_dcid,
                retry_source_connection_id=retry_source_cid,
                session_ticket_fetcher=self._session_ticket_fetcher,
                session_ticket_handler=self._session_ticket_handler,
            )

            conn = self._make_peer_connection(quic_conn, is_initiating=False)
            conn.connection_made(self._transport)
            self._register(conn, header.destination_cid, quic_conn.host_cid)

            logger.debug(
                f"New incoming connection from {addr}, "
                f"cid={quic_conn.host_cid.hex()[:8]}..."
            )

        if conn is not None:
            try:
                conn.datagram_received(data, addr)
            except Exception:
                logger.exception(f"Error processing datagram from {addr}")

    def error_received(self, exc: Exception) -> None:
        logger.error(f"QuicNode UDP error: {exc}")

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def connect(self, host: str, port: int) -> Optional[PeerConnection]:
        """
        Initiate an outgoing QUIC connection to (host, port).

        Returns:
            A connected PeerConnection on success, None on failure.
        """
        quic_conn = QuicConnection(configuration=self._cfg)
        conn = self._make_peer_connection(quic_conn, is_initiating=True)
        conn.connection_made(self._transport)
        self._register(conn, quic_conn.host_cid)

        try:
            conn.connect((host, port))
            conn.transmit()
            await asyncio.wait_for(conn.wait_connected(), timeout=30.0)
            logger.info(f"Connected to {host}:{port}, cid={quic_conn.host_cid.hex()[:8]}...")
            return conn

        except asyncio.TimeoutError:
            logger.warning(f"Connection to {host}:{port} timed out")
            self._deregister(conn)
            return None

        except Exception as e:
            logger.error(f"Connection to {host}:{port} failed: {e}")
            self._deregister(conn)
            return None

    async def keep_alive(self, conn: PeerConnection, interval: float = 10.0) -> None:
        """
        Send periodic QUIC pings to keep the connection alive.

        Run this as a background task after connect() returns:
            asyncio.create_task(node.keep_alive(conn))
        """
        try:
            while True:
                await conn.ping()
                await asyncio.sleep(interval)
        except ConnectionError:
            logger.debug(f"keep_alive ended — {conn.peer_id} disconnected")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"keep_alive error for {conn.peer_id}: {e}")

    def close_all(self) -> None:
        """Gracefully close every connection and shut down the UDP socket."""
        for conn in set(self._cid_map.values()):
            conn.close()
        self._cid_map.clear()
        self._peer_map.clear()
        if self._transport:
            self._transport.close()
            logger.info("QuicNode shut down")

    @property
    def connections(self) -> Set[PeerConnection]:
        """All connections that have completed the TLS handshake."""
        return {c for c in self._cid_map.values() if c.ed25519_public}

    def get_connection(self, ed25519_public: bytes) -> Optional[PeerConnection]:
        """Look up an active connection by the peer's Ed25519 public key."""
        cid = self._peer_map.get(ed25519_public)
        if cid:
            return self._cid_map.get(cid)
        return None

    # ------------------------------------------------------------------ #
    # Internal connection management
    # ------------------------------------------------------------------ #

    def _make_peer_connection(
        self, quic_conn: QuicConnection, is_initiating: bool
    ) -> PeerConnection:
        conn = PeerConnection(
            quic=quic_conn,
            is_initiating=is_initiating,
            on_data=self._on_data,
        )
        # Wire up connection-ID lifecycle callbacks
        conn._connection_id_issued_handler = partial(self._on_cid_issued, conn=conn)
        conn._connection_id_retired_handler = partial(self._on_cid_retired, conn=conn)
        conn._connection_terminated_handler = partial(self._on_conn_terminated, conn=conn)
        quic_conn._logger = logger
        return conn

    def _register(self, conn: PeerConnection, *cids: bytes) -> None:
        for cid in cids:
            self._cid_map[cid] = conn

    def _deregister(self, conn: PeerConnection) -> None:
        for cid in [k for k, v in self._cid_map.items() if v is conn]:
            del self._cid_map[cid]
        if conn.ed25519_public:
            self._peer_map.pop(conn.ed25519_public, None)

    def _on_cid_issued(self, cid: bytes, conn: PeerConnection) -> None:
        self._cid_map[cid] = conn
        if conn.ed25519_public:
            self._peer_map[conn.ed25519_public] = cid
        logger.debug(f"CID issued: {cid.hex()[:8]}...")

    def _on_cid_retired(self, cid: bytes, conn: QuicConnectionProtocol) -> None:
        self._cid_map.pop(cid, None)
        logger.debug(f"CID retired: {cid.hex()[:8]}...")

    def _on_conn_terminated(self, conn: PeerConnection) -> None:
        logger.info(f"Connection terminated: {conn.peer_id}")
        self._deregister(conn)
        if self._on_connection_lost:
            self._on_connection_lost(conn)


# ──────────────────────────────────────────────────────────────────────────────
# Factory function — the main entrypoint for starting a node
# ──────────────────────────────────────────────────────────────────────────────

async def start_node(
    host: str,
    port: int,
    key_dir: str,
    on_data: Optional[DataCallback] = None,
    on_connection_lost: Optional[Callable[["PeerConnection"], None]] = None,
    alpn: str = "quic-pubsub/1",
    seed: Optional[bytes] = None,
    retry: bool = False,
) -> QuicNode:
    """
    Start a QUIC node: generate keys, bind a UDP socket, and return a ready QuicNode.

    Args:
        host:     IP to bind (e.g. "0.0.0.0" or "127.0.0.1")
        port:     UDP port to bind
        key_dir:  Directory where cert.pem / key.pem will be stored
        on_data:  Callback invoked for every incoming stream message
                  signature: (stream_id, data, end_stream, conn) -> None
        alpn:     ALPN protocol identifier (must match between client and server)
        seed:     Optional 32-byte seed for deterministic key generation
        retry:    Enable QUIC Retry (address validation before handshake)

    Returns:
        A running QuicNode bound to host:port
    """
    loop = asyncio.get_running_loop()

    # ── Generate / load identity keys ─────────────────────────────────
    generate_keys(key_dir, seed=seed)

    # ── Bind UDP socket ────────────────────────────────────────────────
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except OSError:
        pass  # SO_REUSEPORT not available on all platforms
    sock.bind((host, port))

    # ── QUIC configuration ─────────────────────────────────────────────
    cfg = QuicConfiguration(
        is_client=True,           # We act as both client and server on one socket
        verify_mode=ssl.CERT_NONE,  # We do our own certificate validation
        max_data=100 * 1024 * 1024,
        max_stream_data=10 * 1024 * 1024,
        max_datagram_size=1350,
        idle_timeout=300,
    )
    cfg.load_cert_chain(
        os.path.join(key_dir, "cert.pem"),
        os.path.join(key_dir, "key.pem"),
    )
    cfg.alpn_protocols = [alpn]

    # ── Session ticket store (enables 0-RTT resumption) ───────────────
    sessions = SessionTicketStore(key_dir)

    # ── Create and bind the node ───────────────────────────────────────
    _, node = await loop.create_datagram_endpoint(
        lambda: QuicNode(
            cfg=cfg,
            on_data=on_data,
            on_connection_lost=on_connection_lost,
            session_ticket_fetcher=sessions.pop,
            session_ticket_handler=sessions.add,
            retry=retry,
        ),
        sock=sock,
    )

    logger.info(f"QuicNode listening on {host}:{port}")
    return node
