FROM node:22-trixie-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm add -g pm2

WORKDIR /app

# Dependency resolution is a build-time operation. Copy the committed lock
# contract before source files so the image is reproducible and later source
# changes cannot make pnpm repair node_modules when the container starts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json shadow-cljs.edn ./

RUN pnpm install --frozen-lockfile

COPY src ./src
COPY web ./web
COPY resources ./resources
COPY ecosystem.container.config.cjs ./ecosystem.container.config.cjs

RUN pnpm build:runtime && pnpm web:build

# Never run containers as root.
# Use the pre-created `node` user in the base image.
RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=8789
ENV PROXX_CLJS_RUNTIME_REQUIRED=true
ENV PROXX_CLJS_POLICY_AUTHORITATIVE=true

EXPOSE 8789
EXPOSE 5174

CMD ["pm2-runtime", "start", "ecosystem.container.config.cjs"]
