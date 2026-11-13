#!/bin/sh
# Copies the list of local domain names into the hosts file. Installed by
# "sudo lcd hosts --auto" and run as root whenever the list changes.
#
# The list is writable by the user, so it is treated strictly as data: only lines
# that are plain domain names are used, and every one points at 127.0.0.1.
#
#   sync-hosts.sh <list-file> [hosts-file]
set -eu
PATH=/usr/bin:/bin
LC_ALL=C
export LC_ALL

LIST="$1"
HOSTS="${2:-/etc/hosts}"
BEGIN='# >>> local-custom-domain >>>'
END='# <<< local-custom-domain <<<'
NAME='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'

tmp=$(mktemp /tmp/lcd-hosts.XXXXXX)
trap 'rm -f "$tmp"' EXIT

# the hosts file without our block
awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$HOSTS" > "$tmp"

if [ -f "$LIST" ] && [ ! -L "$LIST" ]; then
  names=$(head -n 500 "$LIST" | grep -E "$NAME" | sort -u || true)
  if [ -n "$names" ]; then
    {
      echo "$BEGIN"
      echo "$names" | sed 's/^/127.0.0.1 /'
      echo "$END"
    } >> "$tmp"
  fi
fi

# write in place so the hosts file keeps its owner and permissions
cmp -s "$tmp" "$HOSTS" || cat "$tmp" > "$HOSTS"
