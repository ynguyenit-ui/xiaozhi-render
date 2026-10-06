FROM node:22-bookworm-slim
COPY --from=denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno
RUN deno --version
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/yt && /opt/yt/bin/pip install --upgrade --no-cache-dir "yt-dlp[default]"
WORKDIR /app
COPY --chown=node:node . .
USER node
ENV PORT=10000
ENV PYTHON_PATH=/opt/yt/bin/python3
ENV YOUTUBE_JS_RUNTIME=deno
ENV DENO_DIR=/tmp/deno-cache
EXPOSE 10000
CMD ["node", "server.js"]
