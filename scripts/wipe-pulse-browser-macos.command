#!/usr/bin/env bash
# Double-click this in Finder OR run from Terminal. Opens reset page with automated=1
# in your default browser (same machine). Works with file:// origin (local disk Pulse).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="file://${ROOT}/reset-pulse-local-data.html?automated=1&reload=1"
exec open "$URL"
