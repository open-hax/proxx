FROM node:22-trixie-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm add -g pm2

WORKDIR /app

COPY package.json tsconfig.json shadow-cljs.edn ./

RUN pnpm install --no-frozen-lockfile

COPY src ./src
COPY web ./web
COPY ecosystem.container.config.cjs ./ecosystem.container.config.cjs
COPY keys.example.json ./keys.example.json
COPY models.example.json ./models.example.json

RUN pnpm build:runtime && pnpm web:build

# Never run containers as root.
# Use the pre-created `node` user in the base image.
RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=8789
ENV PROXX_CLJS_RUNTIME_REQUIRED=true

EXPOSE 8789
EXPOSE 5174

CMD ["pm2-runtime", "start", "ecosystem.container.config.cjs"]
