#!/usr/bin/env python3
"""
Test client for the QUIC pub/sub broker.

Supports three modes: subscribe, publish, and interactive.

Usage:
    # Subscribe to a topic (prints messages as they arrive):
    python run_client.py sub news

    # Publish a message:
    python run_client.py pub news "Hello, world!"

    # Interactive mode (subscribe + publish from stdin):
    python run_client.py interactive news
"""

import argparse
import asyncio
import logging
import signal
import struct
import sys

from broker.protocols.base import encode_string, encode_bytes, decode_push_frames
from transport.node import start_node
from transport.connection import PeerConnection


class PubSubClient:
    """Thin client that speaks the broker's wire protocol."""

    def __init__(self) -> None:
        self._node = None
        self._conn: PeerConnection | None = None
        # topic -> push buffer (for reassembling length-framed push messages)
        self._push_buffers: dict[str, bytes] = {}
        # topic -> callback
        self._on_message: dict[str, asyncio.Queue] = {}

    async def connect(
        self,
        broker_host: str,
        broker_port: int,
        key_dir: str = "keys/client",
    ) -> None:
        self._node = await start_node(
            host="0.0.0.0",
            port=0,  # OS picks a free port
            key_dir=key_dir,
            on_data=self._on_data,
        )
        self._conn = await self._node.connect(broker_host, broker_port)
        if self._conn is None:
            raise ConnectionError(f"Failed to connect to {broker_host}:{broker_port}")

    async def close(self) -> None:
        if self._node:
            self._node.close_all()

    # ── publish ──────────────────────────────────────────────────────────

    async def publish(self, topic: str, message: bytes) -> bool:
        """
        Publish a message. Returns True on ACK, False on NACK.

        Wire: [0x01][4B topic_len][topic][4B msg_len][message] + FIN
        """
        payload = bytes([0x01]) + encode_string(topic) + encode_bytes(message)
        stream_id = self._conn._quic.get_next_available_stream_id()
        response = await self._conn.request(payload, stream_id)
        return response is not None and len(response) > 0 and response[0] == 0x00

    # ── subscribe ────────────────────────────────────────────────────────

    async def subscribe(self, topic: str) -> asyncio.Queue:
        """
        Subscribe to a topic. Returns a Queue that receives message bytes.

        Wire: [0x02][4B topic_len][topic] + FIN
        """
        queue: asyncio.Queue = asyncio.Queue()
        self._on_message[topic] = queue
        self._push_buffers[topic] = b""

        payload = bytes([0x02]) + encode_string(topic)
        stream_id = self._conn._quic.get_next_available_stream_id()
        self._conn.send_and_close(payload, stream_id)

        # The broker will respond on a server-initiated stream (stream_id+1)
        # with ACK + pushed messages. We handle that in _on_data.
        return queue

    # ── unsubscribe ──────────────────────────────────────────────────────

    async def unsubscribe(self, topic: str) -> None:
        """
        Unsubscribe from a topic.

        Wire: [0x03][4B topic_len][topic] + FIN
        """
        payload = bytes([0x03]) + encode_string(topic)
        stream_id = self._conn._quic.get_next_available_stream_id()
        response = await self._conn.request(payload, stream_id)
        self._on_message.pop(topic, None)
        self._push_buffers.pop(topic, None)

    # ── internal data handler ────────────────────────────────────────────

    def _on_data(
        self,
        stream_id: int,
        data: bytes,
        end_stream: bool,
        conn: PeerConnection,
    ) -> None:
        """
        Handle push data from the broker (subscription messages).

        The broker sends length-framed messages on push streams.
        The first frame is a 1-byte ACK (0x00), subsequent frames are messages.
        """
        # Find which topic this stream belongs to by checking all buffers.
        # Since we might not know the stream→topic mapping yet, we buffer
        # by stream_id first, then decode frames.
        buf_key = f"_stream_{stream_id}"

        if buf_key not in self._push_buffers:
            self._push_buffers[buf_key] = b""

        self._push_buffers[buf_key] += data

        frames, remainder = decode_push_frames(self._push_buffers[buf_key])
        self._push_buffers[buf_key] = remainder

        for frame in frames:
            if len(frame) == 1 and frame[0] == 0x00:
                # ACK frame — subscription confirmed
                continue

            # Deliver to all topic queues (the broker sends on its own stream IDs,
            # so we deliver to all active subscriptions — in practice there's a
            # 1:1 mapping between push streams and topics)
            for topic, queue in self._on_message.items():
                queue.put_nowait(frame)


# ── CLI commands ─────────────────────────────────────────────────────────

async def cmd_subscribe(client: PubSubClient, topic: str) -> None:
    queue = await client.subscribe(topic)
    print(f"Subscribed to '{topic}'. Waiting for messages...\n")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    while not stop.is_set():
        try:
            msg = await asyncio.wait_for(queue.get(), timeout=0.5)
            print(f"[{topic}] {msg.decode('utf-8', errors='replace')}")
        except asyncio.TimeoutError:
            continue

    print("\nUnsubscribing...")
    await client.unsubscribe(topic)


async def cmd_publish(client: PubSubClient, topic: str, message: str) -> None:
    ack = await client.publish(topic, message.encode("utf-8"))
    if ack:
        print(f"Published to '{topic}': {message}")
    else:
        print(f"Publish to '{topic}' failed (NACK)")


async def cmd_interactive(client: PubSubClient, topic: str) -> None:
    queue = await client.subscribe(topic)
    print(f"Subscribed to '{topic}'.")
    print("Type a message and press Enter to publish. Ctrl+C to quit.\n")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    async def print_messages():
        while not stop.is_set():
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=0.5)
                print(f"  <- [{topic}] {msg.decode('utf-8', errors='replace')}")
            except asyncio.TimeoutError:
                continue

    async def read_stdin():
        reader = asyncio.StreamReader()
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
        )
        while not stop.is_set():
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            if not line:
                break
            text = line.decode().strip()
            if text:
                ack = await client.publish(topic, text.encode("utf-8"))
                status = "ack" if ack else "NACK"
                print(f"  -> published ({status})")

    await asyncio.gather(print_messages(), read_stdin())


async def main() -> None:
    parser = argparse.ArgumentParser(description="QUIC pub/sub client")
    parser.add_argument("--broker-host", default="127.0.0.1", help="Broker address")
    parser.add_argument("--broker-port", type=int, default=4433, help="Broker port")
    parser.add_argument("--key-dir", default="keys/client", help="Key storage directory")
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")

    sub = parser.add_subparsers(dest="command", required=True)

    p_sub = sub.add_parser("sub", help="Subscribe to a topic")
    p_sub.add_argument("topic", help="Topic name")

    p_pub = sub.add_parser("pub", help="Publish a message")
    p_pub.add_argument("topic", help="Topic name")
    p_pub.add_argument("message", help="Message to publish")

    p_int = sub.add_parser("interactive", help="Subscribe + publish interactively")
    p_int.add_argument("topic", help="Topic name")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    )

    client = PubSubClient()
    await client.connect(args.broker_host, args.broker_port, args.key_dir)
    print(f"Connected to broker at {args.broker_host}:{args.broker_port}")

    try:
        if args.command == "sub":
            await cmd_subscribe(client, args.topic)
        elif args.command == "pub":
            await cmd_publish(client, args.topic, args.message)
        elif args.command == "interactive":
            await cmd_interactive(client, args.topic)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
