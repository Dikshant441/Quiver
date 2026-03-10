"""
Wire encoding/decoding helpers shared across all broker protocols.

All length fields are big-endian unsigned 32-bit integers.

Frame layout for strings:
    [4B: byte_length][utf-8 bytes]

Frame layout for raw bytes:
    [4B: byte_length][bytes]

Frame layout for a complete pushed message (broker → subscriber):
    [4B: msg_length][msg bytes]
"""

import struct
from typing import Tuple


def encode_string(s: str) -> bytes:
    """Encode a string as [4B len][UTF-8 bytes]."""
    b = s.encode("utf-8")
    return struct.pack(">I", len(b)) + b


def decode_string(data: bytes, offset: int = 0) -> Tuple[str, int]:
    """
    Decode a length-prefixed string starting at `offset`.

    Returns:
        (decoded_string, new_offset)
    """
    (length,) = struct.unpack_from(">I", data, offset)
    offset += 4
    return data[offset : offset + length].decode("utf-8"), offset + length


def encode_bytes(b: bytes) -> bytes:
    """Encode raw bytes as [4B len][bytes]."""
    return struct.pack(">I", len(b)) + b


def decode_bytes(data: bytes, offset: int = 0) -> Tuple[bytes, int]:
    """
    Decode length-prefixed bytes starting at `offset`.

    Returns:
        (raw_bytes, new_offset)
    """
    (length,) = struct.unpack_from(">I", data, offset)
    offset += 4
    return data[offset : offset + length], offset + length


def frame_push(message: bytes) -> bytes:
    """
    Wrap a message in a length prefix for streaming to a subscriber.

    The subscriber accumulates these frames on its push stream and
    decodes them using decode_push_frames().
    """
    return struct.pack(">I", len(message)) + message


def decode_push_frames(buf: bytes) -> Tuple[list[bytes], bytes]:
    """
    Decode as many complete length-prefixed frames as possible from `buf`.

    Returns:
        (list_of_complete_messages, remaining_incomplete_bytes)

    Used by the client to reassemble pushed messages that may arrive
    across multiple QUIC datagrams.
    """
    messages = []
    offset = 0
    while offset + 4 <= len(buf):
        (length,) = struct.unpack_from(">I", buf, offset)
        end = offset + 4 + length
        if end > len(buf):
            break  # incomplete frame — wait for more data
        messages.append(buf[offset + 4 : end])
        offset = end
    return messages, buf[offset:]
