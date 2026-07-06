import { describe, it, expect } from "vitest";
import { logger } from "@/lib/logger";

describe("harness", () => {
  it("resolves the @ alias", () => {
    expect(typeof logger.info).toBe("function");
  });
});
