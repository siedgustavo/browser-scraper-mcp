FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends novnc openbox websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build context is the repo root: the MCP front-end (root server.mjs) is baked
# in as /app/mcp-server.mjs so Kubernetes can run it from this same image.
COPY container/package.json ./
RUN npm install --omit=dev

COPY container/server.mjs container/entrypoint.sh ./
COPY server.mjs /app/mcp-server.mjs
RUN chmod +x /app/entrypoint.sh

ENV DISPLAY=:99 \
    HOME=/data/home \
    SCRAPER_PORT=7317

EXPOSE 6080 7317

ENTRYPOINT ["/app/entrypoint.sh"]
