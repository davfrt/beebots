# Nightly SQLite backup sidecar: sqlite3 baked in (no apk at runtime) and run as the engine's uid, not root.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache age jq openssh-client sqlite && mkdir -p /data /status /work && chown 1000:1000 /data /status /work
COPY --chown=1000:1000 backup.sh restore.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/backup.sh /usr/local/bin/restore.sh && chmod 755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh
USER 1000:1000
CMD ["/usr/local/bin/backup.sh"]
