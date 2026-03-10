class TransportError(Exception):
    """Base error for the transport layer."""
    pass


class HandshakeError(TransportError):
    """Raised when TLS/QUIC handshake fails."""
    pass


class ProtocolError(TransportError):
    """Raised when an unknown or malformed protocol message is received."""
    pass


class ConnectionClosedError(TransportError):
    """Raised when trying to send on a closing or closed connection."""
    pass
