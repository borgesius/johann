import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? "4173");
const { server } = createApp();

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`release-orch seed listening on http://127.0.0.1:${port}\n`);
});
