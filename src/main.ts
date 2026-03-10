import { createApp } from "./app.js";
import { loadConfig } from "./lib/config.js";

const config = loadConfig();
const app = await createApp(config);

await app.listen({ host: config.host, port: config.port });
app.log.info({ host: config.host, port: config.port }, "open-hax-openai-proxy listening");
