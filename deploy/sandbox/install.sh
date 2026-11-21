#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"

getent group cb-sandbox >/dev/null || groupadd --system cb-sandbox
id cb-build >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin cb-build
usermod -aG cb-sandbox cb-build
usermod -aG cb-sandbox coordinating-brain

install -d -m 755 /usr/local/lib/cb/bin
install -m 755 "$SRC/run-tests" /usr/local/lib/cb/run-tests
install -m 755 "$SRC/flutter-ro" /usr/local/lib/cb/bin/flutter
install -m 644 "$SRC/cb-test@.service" /etc/systemd/system/cb-test@.service
install -m 644 "$SRC/50-cb-test.rules" /etc/polkit-1/rules.d/50-cb-test.rules
install -m 644 "$SRC/cb-sandbox.conf" /etc/tmpfiles.d/cb-sandbox.conf
systemd-tmpfiles --create /etc/tmpfiles.d/cb-sandbox.conf

install -d -m 755 /etc/systemd/system/cb-test@.service.d
{
  echo "[Service]"
  for f in /opt/flutter/bin/cache/*.stamp; do
    chgrp cb-sandbox "$f"
    chmod g+w "$f"
    echo "ReadWritePaths=$f"
  done
} > /etc/systemd/system/cb-test@.service.d/stamps.conf
systemctl daemon-reload
echo "Sandbox installed: $(grep -c ReadWritePaths /etc/systemd/system/cb-test@.service.d/stamps.conf) writable stamp files."
