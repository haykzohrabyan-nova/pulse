#!/usr/bin/env bash
# Double-click this in Finder OR run from Terminal.
# Start the app first: python3 -m http.server 8081
# Then open: http://127.0.0.1:8081/pages/reset-pulse-local-data.html?automated=1&reload=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:8081/pages/reset-pulse-local-data.html?automated=1&reload=1"
exec open "$URL"
