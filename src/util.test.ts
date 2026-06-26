import { describe, it, expect } from "vitest";
import { ping } from "./util.ts";

describe("tooling", () => {
  it("vitest резолвит .ts импорты", () => {
    expect(ping()).toBe("pong");
  });
});
