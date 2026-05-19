const path = require("path");
const cwd = __dirname;

module.exports = {
  apps: [
    {
      name: "proxy-dev",
      script: "pnpm",
      args: ["dev"],
      cwd,
      env: {
        NODE_ENV: "development",
        PROXY_HOST: "127.0.0.1",
        PROXY_PORT: "8789",
        PORT: "8789",
      },
      autorestart: false,
      watch: false,
      time: true,
      kill_timeout: 3000,
    },
    {
      name: "proxy-dev-web",
      script: "pnpm",
      args: ["web:dev", "--", "--host", "127.0.0.1", "--port", "5175"],
      cwd,
      env: {
        NODE_ENV: "development",
      },
      autorestart: false,
      watch: false,
      time: true,
      kill_timeout: 3000,
    },
  ],
};
