import { describe, expect, it } from "vitest";
import { ENGINE_STORE_FILENAME, engineStorePath } from "./paths.js";

describe("engineStorePath", () => {
  it("returns the canonical engine store location", () => {
    expect(ENGINE_STORE_FILENAME).toBe("engine-store.sqlite");
    expect(engineStorePath("/vault")).toBe("/vault/.oms/engine-store.sqlite");
  });

  it("normalizes a trailing vault separator", () => {
    expect(engineStorePath("/vault/")).toBe("/vault/.oms/engine-store.sqlite");
  });
});
