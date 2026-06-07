import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceGraph, getDownstreamServices } from "../domain/service-graph.js";
import { createDefaultPromotionPolicy } from "../domain/promotion-policy.js";
import { createSimulatedFleet } from "../sim/fleet.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../web");

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function serveFile(response, relativePath, contentType) {
  const target = path.join(webRoot, relativePath);
  const body = await readFile(target, "utf8");
  response.writeHead(200, { "content-type": contentType });
  response.end(body);
}

export function createApp() {
  const fleet = createSimulatedFleet();
  const graph = createServiceGraph();
  const policy = createDefaultPromotionPolicy();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        queueDepth: fleet.environments.reduce((sum, environment) => sum + environment.queueDepth, 0),
      });
    }

    if (url.pathname === "/api/fleet") {
      return json(response, 200, {
        graph,
        policy,
        fleet,
        focusService: {
          id: "pricing",
          downstreamServices: getDownstreamServices(graph, "pricing"),
        },
      });
    }

    if (url.pathname === "/app.js") {
      return serveFile(response, "app.js", "application/javascript; charset=utf-8");
    }

    if (url.pathname === "/styles.css") {
      return serveFile(response, "styles.css", "text/css; charset=utf-8");
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile(response, "index.html", "text/html; charset=utf-8");
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  return { server };
}
