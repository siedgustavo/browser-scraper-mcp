FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends novnc openbox websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV DISPLAY=:99 \
    HOME=/data/home \
    SCRAPER_PORT=7317

EXPOSE 6080 7317

ENTRYPOINT ["/app/entrypoint.sh"]
