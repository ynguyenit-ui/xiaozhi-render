FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/yt && /opt/yt/bin/pip install --no-cache-dir "yt-dlp[default]"
WORKDIR /app
COPY --chown=node:node . .
USER node
ENV PORT=10000
ENV PYTHON_PATH=/opt/yt/bin/python3
EXPOSE 10000
CMD ["node", "server.js"]
