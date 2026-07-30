#!/usr/bin/env bash
set -euo pipefail
node "$(cd "$(dirname "$0")" && pwd)/prepare-sidecar.mjs"
