import { getServerConfig } from "../config.js";
import { createLanternServer } from "../server/http.js";

const config = getServerConfig();
const server = createLanternServer({ serverConfig: config });

server.listen(config.port, () => {
  console.error(`Lantern web service listening on port ${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`Lantern web service stopping (${signal})...`);
    server.close(() => {
      console.error("Lantern web service stopped.");
    });
  });
}
