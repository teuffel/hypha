#!/bin/sh
#
# Hypha runtime entrypoint.
#
# Validates the data-volume permissions before starting hypha-server,
# replacing the cryptic better-sqlite3 "SQLITE_CANTOPEN" with an
# actionable message that names the exact host commands to fix it.
#
# The most common cause of this trap on first-run: a Docker bind mount
# where the host path was created by the daemon (root-owned) because
# the operator skipped `mkdir ./data` before `docker compose up`.

set -eu

DATA_DIR="${HYPHA_DATA_DIR:-/data}"
UID_NUM="$(id -u)"
GID_NUM="$(id -g)"

if [ ! -d "$DATA_DIR" ]; then
  cat >&2 <<EOF
FATAL: $DATA_DIR does not exist inside the container.

This shouldn't happen with the bundled docker-compose.hypha.yml. If
you're running the image manually, ensure your bind mount or volume
points at a directory.
EOF
  exit 1
fi

probe="$DATA_DIR/.hypha-write-probe"
if ! ( : > "$probe" ) 2>/dev/null; then
  cat >&2 <<EOF
FATAL: $DATA_DIR is not writable by container user (UID $UID_NUM, GID $GID_NUM).

This typically means the host directory was auto-created by Docker as root
when you ran 'docker compose up' without first creating it as your user.

Fix on the host:

  docker compose -f docker-compose.hypha.yml down
  sudo rm -rf ./data
  mkdir ./data
  docker compose -f docker-compose.hypha.yml up

Or, to keep the existing directory:

  sudo chown -R $UID_NUM:$GID_NUM ./data

See docs/hypha/self-hosting.md (step 4) for the full walkthrough.
EOF
  exit 1
fi
rm -f "$probe"

exec "$@"
