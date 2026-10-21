#!/bin/sh
# TonUINO Studio: activate the udev rules for USB serial adapters and NFC readers.
set -e
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
  udevadm trigger --action=add --subsystem-match=tty || true
  udevadm trigger --action=add --subsystem-match=usb || true
fi
exit 0
