ARG LITE_TOOL_PROFILE=node-profile
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates git patch procps ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.7.0 --activate \
    && mkdir -p /workspace \
    && chown node:node /workspace

WORKDIR /workspace
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

FROM runtime AS node-profile

FROM runtime AS python-profile
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
USER node

FROM ${LITE_TOOL_PROFILE} AS final
