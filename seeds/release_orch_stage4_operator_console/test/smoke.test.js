import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";

test("health endpoint responds with ok", async () => {
  const { server } = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
  }
});
