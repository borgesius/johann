import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";

test("health endpoint responds", async () => {
  const address = await new Promise((resolve) => {
    const instance = server.listen(0, () => resolve(instance.address()));
  });
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();
    assert.equal(body.status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
