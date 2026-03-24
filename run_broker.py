#!/usr/bin/env python3
"""
Entry point for the QUIC pub/sub broker.

Usage:
    python run_broker.py
    python run_broker.py --host 0.0.0.0 --port 4433
    python run_broker.py --port 5555 --key-dir keys/my-broker
"""

import argparse
import asyncio
import logging
import signal

from broker import Broker


async def main(host: str, port: int, key_dir: str) -> None:
    broker = Broker()
    await broker.start(host=host, port=port, key_dir=key_dir)

    print(f"Broker running on {host}:{port}  (Ctrl+C to stop)")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await stop.wait()

    print("\nShutting down...")
    await broker.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="QUIC pub/sub broker")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=4433, help="UDP port (default: 4433)")
    parser.add_argument("--key-dir", default="keys/broker", help="Key storage directory")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    )

    asyncio.run(main(args.host, args.port, args.key_dir))
