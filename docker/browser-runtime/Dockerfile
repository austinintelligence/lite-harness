FROM mcr.microsoft.com/playwright:v1.61.0-noble@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a

USER root
WORKDIR /opt/lite-browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY server.mjs ./server.mjs
RUN chown -R pwuser:pwuser /opt/lite-browser
USER pwuser
ENTRYPOINT ["node", "/opt/lite-browser/server.mjs"]
