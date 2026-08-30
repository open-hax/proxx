module.exports = {
  apps: [
    {
      name: "open-hax-openai-proxy",
      script: "node",
      args: ["dist/main.js"],
      cwd: "/app",
      env: {
        NODE_ENV: "production",
        PROXY_HOST: "0.0.0.0",
        PROXY_PORT: "8789"
      },
      autorestart: true,
      watch: false,
      time: true,
      kill_timeout: 5000,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s"
    },
    {
      name: "open-hax-openai-proxy-web",
      // Invoke the already-installed Vite entrypoint directly. Running
      // `pnpm exec` here makes pnpm reconcile dependencies in production,
      // so a package policy or registry change can take down a built image.
      script: "node",
      args: ["node_modules/vite/bin/vite.js", "preview", "--config", "web/vite.config.ts", "--host", "0.0.0.0", "--port", "5174"],
      cwd: "/app",
      env: {
        NODE_ENV: "production",
        CI: "true"
      },
      autorestart: true,
      watch: false,
      time: true,
      kill_timeout: 5000,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s"
    }
  ]
};
