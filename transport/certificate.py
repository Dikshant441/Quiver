"""
Ed25519 certificate generation and verification for QUIC node identity.

Each node generates a self-signed TLS certificate where:
- The key pair is Ed25519
- The Subject Alternative Name (SAN) is a deterministic encoding of the public key

This means any peer can verify a node's identity just from its certificate —
no certificate authority needed.
"""

import os
import logging
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

logger = logging.getLogger(__name__)


def generate_san(pubkey: bytes) -> str:
    """
    Encode a 32-byte Ed25519 public key as a DNS SAN string.

    The encoding is:
        N(k) = "e" + base32_custom(little_endian_int(k), 52 chars)

    This produces a unique, deterministic, DNS-safe identifier for any public key.
    A peer receiving a certificate can recompute the expected SAN from the public
    key and verify it matches — binding the certificate to the key.

    Args:
        pubkey: 32-byte raw Ed25519 public key

    Returns:
        53-character string starting with "e"
    """
    if len(pubkey) != 32:
        raise ValueError("Public key must be exactly 32 bytes")

    alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    n = int.from_bytes(pubkey, "little")

    result = ""
    for _ in range(52):
        result += alphabet[n % 32]
        n //= 32

    return "e" + result


def generate_keys(key_dir: str, seed: bytes | None = None) -> tuple[str, Ed25519PrivateKey]:
    """
    Generate an Ed25519 key pair and a self-signed TLS certificate, then save
    them to disk.

    Args:
        key_dir: Directory to write cert.pem, key.pem, and pub_key.pem
        seed:    Optional 32-byte seed to derive a deterministic key.
                 Pass None to generate a random key.

    Returns:
        (san, private_key)
            san:         The SAN string encoding of the public key
            private_key: The Ed25519PrivateKey object (in-memory)
    """
    os.makedirs(key_dir, exist_ok=True)

    if seed is not None:
        if len(seed) != 32:
            raise ValueError("Seed must be exactly 32 bytes")
        private_key = Ed25519PrivateKey.from_private_bytes(seed)
    else:
        private_key = Ed25519PrivateKey.generate()

    # ── Persist private key ────────────────────────────────────────────
    private_key_pem = private_key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    )
    with open(os.path.join(key_dir, "key.pem"), "wb") as f:
        f.write(private_key_pem)

    # ── Persist public key ─────────────────────────────────────────────
    public_key = private_key.public_key()
    public_key_pem = public_key.public_bytes(
        encoding=Encoding.PEM,
        format=PublicFormat.SubjectPublicKeyInfo,
    )
    with open(os.path.join(key_dir, "pub_key.pem"), "wb") as f:
        f.write(public_key_pem)

    # ── Build SAN from raw public key bytes ────────────────────────────
    raw_pub = public_key.public_bytes_raw()
    san = generate_san(raw_pub)

    # ── Build self-signed certificate ──────────────────────────────────
    valid_from = datetime.now(timezone.utc)
    valid_to = valid_from + timedelta(days=365)

    subject = issuer = x509.Name([
        x509.NameAttribute(x509.NameOID.COMMON_NAME, "QUIC PubSub Node")
    ])

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(valid_from)
        .not_valid_after(valid_to)
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(san)]),
            critical=False,
        )
        .sign(private_key=private_key, algorithm=None)
    )

    with open(os.path.join(key_dir, "cert.pem"), "wb") as f:
        f.write(cert.public_bytes(Encoding.PEM))

    logger.debug(f"Keys written to {key_dir!r}, SAN={san[:16]}...")
    return san, private_key


def verify_certificate(cert: x509.Certificate) -> tuple[bool, Exception | None]:
    """
    Verify a peer's self-signed Ed25519 certificate.

    Checks:
        1. Certificate is currently valid (not expired, not future-dated)
        2. Public key algorithm is Ed25519
        3. The SAN matches the public key (cryptographic binding)
        4. The certificate was signed with Ed25519

    Returns:
        (True, None) on success
        (False, exception) on failure — caller decides whether to close the connection
    """
    try:
        now = datetime.now(timezone.utc)

        if cert.not_valid_before_utc > now:
            raise ValueError("Certificate is not yet valid.")
        if cert.not_valid_after_utc < now:
            raise ValueError("Certificate has expired.")

        pk = cert.public_key()
        if not isinstance(pk, Ed25519PublicKey):
            raise ValueError("Certificate public key must be Ed25519.")

        # Recompute expected SAN from the public key and compare
        expected_san = generate_san(pk.public_bytes_raw())
        san_ext = cert.extensions.get_extension_for_oid(
            x509.oid.ExtensionOID.SUBJECT_ALTERNATIVE_NAME
        )
        san_values = san_ext.value.get_values_for_type(x509.general_name.DNSName)

        if len(san_values) != 1:
            raise ValueError("Certificate must have exactly one SAN.")
        if san_values[0] != expected_san:
            raise ValueError("SAN does not match the public key.")

        if cert.signature_algorithm_oid != x509.SignatureAlgorithmOID.ED25519:
            raise ValueError("Expected Ed25519 signature algorithm.")

        return True, None

    except Exception as e:
        return False, e
