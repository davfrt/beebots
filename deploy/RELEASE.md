# Production release

Deploy only a release manifest whose three image references are `@sha256` digests. Copy the `release.env` asset published with the GitHub release to `deploy/release.env`, add `PUBLIC_DOMAIN` with a DNS-resolved domain, then run:

```sh
docker compose --env-file deploy/release.env -f docker-compose.yml -f deploy/production-compose.yml pull
docker compose --env-file deploy/release.env -f docker-compose.yml -f deploy/production-compose.yml up -d
```

Caddy redirects public HTTP to HTTPS; do not expose Setup through an IP address or a plain-HTTP proxy. Record the manifest alongside the deployment. `/health` reports its `release` value.

To rehearse an upgrade, back up the `bees-data` volume, deploy the new manifest, and confirm `/health` is reconciled. Roll back with the prior compatible manifest using the same two commands. Do not restore an older database over live exposure: first confirm every account is flat or reconciled with exchange authority.

## Backup and restore

Off-host backup is optional (ADR 0002: the operator accepted losing local history if the host is lost; funds and positions stay authoritative on OKX). Without it, rely on the host provider's snapshots and record that choice with the release.

To enable it, add `--profile backup -f deploy/backup-compose.yml` to both commands above and, before starting, set `BACKUP_AGE_RECIPIENT` to an off-host age public key, `BACKUP_SSH_TARGET` to an SSH-only account and absolute remote directory, and `BACKUP_SSH_KEY_FILE` plus `BACKUP_SSH_KNOWN_HOSTS_FILE` to local read-only files. The backup container can read application data but cannot write it; it writes only a local status volume, encrypts every `*.sqlite` database plus `settings.json`, Hive state, portraits, and the digest-pinned release manifest, verifies SQLite integrity, then atomically publishes the encrypted archive remotely. It keeps 30 days remotely by default (`BACKUP_RETENTION_DAYS`).

`/health` becomes non-green and sends one alert when the backup fails or is older than 26 hours. Preserve the latest archive name and its remote timestamp as operational evidence. The encryption identity is the recovery boundary: it is deliberately not stored on the application host, nor are live exchange credentials copied outside the encrypted archive.

Restore only into an isolated empty directory and confirm the expected mode before starting an engine:

```sh
docker compose --env-file deploy/release.env -f docker-compose.yml -f deploy/production-compose.yml --profile backup -f deploy/backup-compose.yml run --rm \
  -v /srv/beebots-recovery:/restore-input:ro -v /srv/beebots-restore:/restore-output backup \
  restore.sh /restore-input/beebots-YYYYMMDDTHHMMSSZ.tar.gz.age /restore-input/age-identity.txt /restore-output
```

Mount the remote archive and identity into `/restore-input` read-only and inspect `/restore-output`. `restore.sh` decrypts, verifies each database with `PRAGMA integrity_check`, checks its stored mode against its filename, and requires `settings.json` plus the release manifest. Start the engine against a copied output only after that check. Never restore a historical database onto a live account with unresolved exchange exposure.

For the restore drill, start the restored **dry** data with the release engine image in an isolated network and save the `engine http listening` log line as evidence. A demo/live restore also needs its credentials from the separate secret store; they are never recovered from the release manifest.

```sh
timeout 10 docker run --rm --network none -v /srv/beebots-restore:/data "$ENGINE_IMAGE" 2>&1 | grep -F 'engine http listening'
```
