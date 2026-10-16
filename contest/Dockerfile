# TSecBench hosted Agent image (example).
#
# The platform does not mandate Dockerfile / ENTRYPOINT / CMD / WORKDIR.
# The behavioral rule is: after the container starts, it must begin solving
# on its own. ENTRYPOINT below is how this repo meets that rule.
#
# Do not bake secrets into the image. The platform injects BENCHMARK_TOKEN and
# BENCHMARK_BASE_URL at runtime — do not set them here or on the upload form.
# Put LLM keys in the upload-page env. Upload cap is 3GB (.tar / .tar.gz / .tgz).
#
# Hosted has no public internet. Set SOLVER_GATEWAY=1 at runtime so the driver
# rewrites model bases only (never BENCHMARK_BASE_URL):
#   https://api.deepseek.com/anthropic → http://api.deepseek.com.tsecbench.gw/anthropic
#
# dsh is not vendored in this P0 skeleton. Install the harness in the real
# image. Until dsh is on PATH the driver records a launch stub. FGS pre-seed
# runs only for the contest profile.
#
# The driver also runs the contest supervisor (reap / retire / dual-guard).
# Do not add a second autosup process to this image.
#
#   docker build -f contest/Dockerfile -t fgs-contest .
#   docker save fgs-contest:latest | gzip > agent.tar.gz
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/fgs-v4
COPY . .
RUN chmod +x contest/entrypoint.sh contest/supervisor/*.sh \
 && mkdir -p /var/lib/fgs-contest /opt/dsh/profiles \
 && cp -a profiles/contest-baseline /opt/dsh/profiles/contest-baseline \
 && cp -a profiles/contest /opt/dsh/profiles/contest

# Per-challenge cwds. Token and base URL stay out of the image.
# Messages root is /anthropic, not the chat /v1 root (that path 404s).
# New workers use contest-baseline until CONTEST_FGS_AFTER_SEC, then contest.
ENV CONTEST_WORKDIR=/var/lib/fgs-contest \
    DSH_HOME=/opt/dsh \
    DSH_PERMISSION_MODE=danger-full-access \
    DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic \
    CONTEST_DSH_LAUNCH=1 \
    CONTEST_DSH_PROFILE=contest-baseline \
    CONTEST_DSH_PROFILE_FGS=contest \
    CONTEST_FGS_AFTER_SEC=7200 \
    CONTEST_SUPERVISOR=1 \
    CONTEST_MAX_ACTIVE=3 \
    CONTEST_RETIRE_GRACE=60 \
    CONTEST_RETIRE_GRACE_SOLVED=30 \
    CONTEST_SUPERVISOR_INTERVAL=20

ENTRYPOINT ["contest/entrypoint.sh"]
