#!/bin/sh
# TSecBench hosted Agent entry.
#
# The platform does not mandate ENTRYPOINT syntax. It does require the image
# to start solving by itself after the container launches. This script is that
# start: validate the injected env, then exec the driver. The driver lists
# challenges, starts each one, disk-seeds FGS, and only then launches dsh.
#
# Do not bake BENCHMARK_TOKEN, BENCHMARK_BASE_URL, or LLM keys into the image.
# The platform injects the first two at runtime. Fill model keys on the upload
# page (or a runtime env file), never in this script.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -z "${BENCHMARK_TOKEN:-}" ]; then
  echo "contest: missing BENCHMARK_TOKEN (platform injects this at runtime; do not bake it into the image)" >&2
  exit 1
fi

if [ -z "${BENCHMARK_BASE_URL:-}" ]; then
  echo "contest: missing BENCHMARK_BASE_URL (platform injects this at runtime; do not bake it into the image)" >&2
  exit 1
fi

# SOLVER_GATEWAY=1: the driver rewrites allowlisted model base URLs
#   https://api.deepseek.com/v1 → http://api.deepseek.com.tsecbench.gw/v1
# Hosted sandboxes have no public internet. Leave the flag unset for local runs.
#
# VPN is optional. Integration docs say challenge addresses need a task VPN;
# the hosted upload page does not say the sandbox already includes one.
# Default is off (CONTEST_VPN unset) so pre-seed is not blocked on that ambiguity.
# Set CONTEST_VPN=1 plus CONTEST_VPN_CONFIG and CONTEST_VPN_EXEC to opt in.

exec python3 "$ROOT/contest/driver.py" "$@"
