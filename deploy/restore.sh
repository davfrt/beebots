#!/bin/sh
set -eu

archive=${1:?archive path required}
identity=${2:?age identity path required}
destination=${3:?empty restore directory required}
test ! -e "$destination" || test -z "$(find "$destination" -mindepth 1 -print -quit)"
mkdir -p "$destination"
age -d -i "$identity" "$archive" | tar -xz -C "$destination"
for db in "$destination"/databases/*.sqlite; do
  test "$(sqlite3 "$db" 'PRAGMA integrity_check')" = ok
  name=$(basename "$db" .sqlite)
  case "$(sqlite3 "$db" "SELECT value FROM meta WHERE key = 'mode'")" in dry|demo|live) ;; *) exit 1;; esac
  case "$name" in bees-*) test "$(sqlite3 "$db" "SELECT value FROM meta WHERE key = 'mode'")" = "${name##*-}";; esac
done
jq -e '.version == 1 and (.jevKey | type == "string" and length >= 8) and (.acceptedRiskAt | type == "number") and (.createdAt | type == "number") and (.bees | type == "array" and length == 3 and all(.[]; (.name | type == "string") and (.style | IN("bizzy"; "breezy"; "boozy"))))' "$destination/settings.json" >/dev/null
test -f "$destination/release.env"
