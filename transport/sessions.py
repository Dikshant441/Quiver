"""
QUIC session ticket store — enables 0-RTT connection resumption.

When a client reconnects to a server it has connected to before, QUIC can
skip the full TLS handshake using a stored session ticket. This reduces
connection setup from 1 RTT to 0 RTT, which matters for pub/sub clients
that frequently reconnect.

Tickets are persisted to disk so they survive process restarts.
"""

import os
import pickle
import logging
from typing import Dict, Optional

from aioquic.tls import SessionTicket

logger = logging.getLogger(__name__)


class SessionTicketStore:
    """
    Disk-backed store for QUIC session tickets.

    Pass `store.add` as `session_ticket_handler` and `store.pop` as
    `session_ticket_fetcher` when building a QuicConfiguration.
    """

    def __init__(self, store_dir: str) -> None:
        os.makedirs(store_dir, exist_ok=True)
        self._path = os.path.join(store_dir, "session_tickets.pkl")
        self._tickets: Dict[bytes, SessionTicket] = self._load()

    def add(self, ticket: SessionTicket) -> None:
        """Called by aioquic when a new session ticket is issued."""
        self._tickets[ticket.ticket] = ticket
        self._save()
        logger.debug("Session ticket stored")

    def pop(self, label: bytes) -> Optional[SessionTicket]:
        """Called by aioquic when resuming a session — returns and removes the ticket."""
        ticket = self._tickets.pop(label, None)
        if ticket:
            self._save()
            logger.debug("Session ticket retrieved for resumption")
        return ticket

    def _save(self) -> None:
        with open(self._path, "wb") as f:
            pickle.dump(self._tickets, f)

    def _load(self) -> Dict[bytes, SessionTicket]:
        try:
            with open(self._path, "rb") as f:
                return pickle.load(f)
        except (FileNotFoundError, EOFError):
            return {}
