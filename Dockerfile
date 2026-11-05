# Gbsidian backend, containerized.
#
# The API is Python-stdlib-only, so the build is just copying three files —
# no pip install, no build stage. Runs as a non-root user; the API itself
# enforces the token and jails every requested path to a configured vault root.
#
# Required env (see .env.example / docker-compose.yml):
#   G2SIDIAN_TOKEN       bearer token (the API refuses to start without one)
#   G2SIDIAN_VAULTS       JSON: [{"name":"Personal","path":"/vaults/personal"}, ...]
#
# Inside the container the API binds 0.0.0.0 (compose sets G2SIDIAN_BIND; there
# is no tailscale binary in the image and its interface is a veth anyway).
# Exposure is governed HOST-side by the port publish: docker-compose.yml binds
# 127.0.0.1 only, so the container is reachable only through what you put in
# front of the published port — `tailscale serve` for the glasses app, an SSH
# tunnel, a local proxy. Same posture as install.sh's loopback+tailnet default.
FROM python:3.12-slim

COPY g2sidian_api.py md_flatten.py vault_query.py /app/
WORKDIR /app

# Non-root user + writable state dir for out-of-vault write backups.
RUN useradd --system --home-dir /app --shell /usr/sbin/nologin g2sidian \
    && mkdir -p /home/g2sidian/.local/state/g2sidian/backups \
    && chown -R g2sidian:g2sidian /home/g2sidian
USER g2sidian

# The API reads the port from G2SIDIAN_API_PORT (default 8793).
EXPOSE 8793
CMD ["python", "g2sidian_api.py"]
