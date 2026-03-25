# ── Base image: Python 3.13 on minimal Linux ──────────────────────────
FROM python:3.13-slim

# ── System dependencies required by aioquic / cryptography ────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libffi-dev && \
    rm -rf /var/lib/apt/lists/*

# ── Working directory inside the container ────────────────────────────
WORKDIR /app

# ── Install Python dependencies first (better layer caching) ─────────
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

# ── Copy project source code ─────────────────────────────────────────
COPY broker/ broker/
COPY transport/ transport/
COPY utils/ utils/
COPY run_broker.py .
COPY run_client.py .

# ── Prepare key storage directory ─────────────────────────────────────
RUN mkdir -p keys/broker

# ── Expose the QUIC (UDP) port ────────────────────────────────────────
EXPOSE 4433/udp

# ── Default startup command ──────────────────────────────────────────
CMD ["python", "run_broker.py", "--host", "0.0.0.0", "--port", "4433", "-v"]
