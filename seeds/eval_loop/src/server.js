import http from "node:http";

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    message: "todo service",
    path: request.url ?? "/"
  }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(3030);
}

export { server };
