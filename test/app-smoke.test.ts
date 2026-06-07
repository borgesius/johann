import { describe, expect, it } from "vitest";
import { normalizeBrowserStartCommand } from "../src/app-smoke.js";

describe("normalizeBrowserStartCommand", () => {
  it("normalizes brittle Vite preview commands to explicit host and port flags", () => {
    expect(
      normalizeBrowserStartCommand("PORT=4173 npm run preview", "http://127.0.0.1:4173"),
    ).toBe("npm run preview -- --host 127.0.0.1 --port 4173");
  });

  it("leaves already explicit preview commands alone", () => {
    expect(
      normalizeBrowserStartCommand(
        "npm run preview -- --host 127.0.0.1 --port 4173",
        "http://127.0.0.1:4173",
      ),
    ).toBe("npm run preview -- --host 127.0.0.1 --port 4173");
  });

  it("normalizes brittle Vite dev commands to explicit host and port flags", () => {
    expect(
      normalizeBrowserStartCommand("PORT=3000 npm run dev", "http://127.0.0.1:3000"),
    ).toBe("npm run dev -- --host 127.0.0.1 --port 3000");
  });
});
