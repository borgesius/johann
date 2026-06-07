import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../src/utils.js";

describe("extractJsonObject", () => {
  it("extracts a valid JSON object even when prose surrounds it", () => {
    const raw = `Now I'll create the scaffold.\n{"type":"write_file","path":"src/main.ts","content":"const value = {\\"ok\\": true};\\n"}\nNext I'll continue.`;
    const extracted = extractJsonObject(raw);

    expect(extracted).toBe(
      "{\"type\":\"write_file\",\"path\":\"src/main.ts\",\"content\":\"const value = {\\\"ok\\\": true};\\n\"}",
    );
  });

  it("ignores invalid brace spans and finds the first parseable JSON object", () => {
    const raw = `not-json {oops}\n{"type":"finish","result":{"summary":"done"}} trailing words`;
    const extracted = extractJsonObject(raw);

    expect(extracted).toBe("{\"type\":\"finish\",\"result\":{\"summary\":\"done\"}}");
  });
});
