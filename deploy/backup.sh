#!/bin/sh
set -eu

status=/status/status.json
work=/work

write_status() {
  tmp="$status.tmp"
  printf '{"ok":%s,"completedAt":%s,"error":"%s"}\n' "$1" "$(date -u +%s000)" "${2:-}" > "$tmp"
  mv "$tmp" "$status"
}

backup() {
  test -n "${BACKUP_AGE_RECIPIENT:-}" || return 1
  test -n "${BACKUP_SSH_TARGET:-}" || return 1
  case "$BACKUP_SSH_TARGET" in *[!A-Za-z0-9@._:/-]*|*:*:*|*:|:*|*//*) return 1;; esac
  retention=${BACKUP_RETENTION_DAYS:-30}
  case "$retention" in ''|*[!0-9]*) return 1;; esac
  host=${BACKUP_SSH_TARGET%%:*}
  remote=${BACKUP_SSH_TARGET#*:}
  key=${BACKUP_SSH_KEY_PATH:-/run/secrets/backup_ssh_key}
  known=${BACKUP_SSH_KNOWN_HOSTS_PATH:-/run/secrets/backup_known_hosts}
  test -s "$key" || return 1
  test -s "$known" || return 1
  rm -rf "$work"/*
  mkdir -p "$work/recovery/databases"
  databases_before=$(find /data -maxdepth 1 -type f -name '*.sqlite' -print | sort)
  for db in /data/*.sqlite; do
    test -f "$db" || continue
    test -f "$db" || continue
    name=$(basename "$db")
    sqlite3 "$db" ".backup '$work/recovery/databases/$name'"
    test "$(sqlite3 "$work/recovery/databases/$name" 'PRAGMA integrity_check')" = ok
  done
  test -n "$(find "$work/recovery/databases" -type f -name '*.sqlite' -print -quit)"
  test "$databases_before" = "$(find /data -maxdepth 1 -type f -name '*.sqlite' -print | sort)"
  for file in settings.json hive.json; do test ! -f "/data/$file" || cp "/data/$file" "$work/recovery/$file"; done
  test ! -f /config/release.env || cp /config/release.env "$work/recovery/release.env"
  test ! -d /data/bee-images || cp -R /data/bee-images "$work/recovery/bee-images"
  find "$work/recovery/databases" -type f -name '*.sqlite' -exec sh -c 'printf "%s %s\\n" "$(basename "$1")" "$(sqlite3 "$1" "SELECT v FROM meta WHERE k = '\''mode'\''")"' sh {} \; > "$work/recovery/databases.txt"
  tar -C "$work/recovery" -czf "$work/recovery.tar.gz" .
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  archive="beebots-$stamp.tar.gz.age"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$work/$archive" "$work/recovery.tar.gz"
  cp "$key" "$work/key" && chmod 600 "$work/key"
  opts="-i $work/key -o UserKnownHostsFile=$known -o StrictHostKeyChecking=yes"
  ssh $opts "$host" "mkdir -p '$remote'"
  scp $opts "$work/$archive" "$host:$remote/.$archive.part"
  ssh $opts "$host" "mv '$remote/.$archive.part' '$remote/$archive'; find '$remote' -type f -name 'beebots-*.tar.gz.age' -mtime +$retention -delete"
}

mkdir -p /status /work
while true; do
  if backup; then write_status true; else write_status false "backup upload or verification failed"; fi
  test "${BACKUP_ONCE:-false}" != true || exit 0
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
