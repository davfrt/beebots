# Production release

Deploy only a release manifest whose three image references are `@sha256` digests. Copy the `release.env` asset published with the GitHub release to `deploy/release.env`, add `PUBLIC_DOMAIN` with a DNS-resolved domain, then run:

```sh
docker compose --env-file deploy/release.env -f docker-compose.yml -f deploy/production-compose.yml pull
docker compose --env-file deploy/release.env -f docker-compose.yml -f deploy/production-compose.yml up -d
```

Caddy redirects public HTTP to HTTPS; do not expose Setup through an IP address or a plain-HTTP proxy. Record the manifest alongside the deployment. `/health` reports its `release` value.

To rehearse an upgrade, back up the `bees-data` volume, deploy the new manifest, and confirm `/health` is reconciled. Roll back with the prior compatible manifest using the same two commands. Do not restore an older database over live exposure: first confirm every account is flat or reconciled with exchange authority.
