import { describe, it, expect } from "vitest";
import { signUnpublishToken, verifyUnpublishToken } from "@/lib/unpublish-token";

describe("unpublish token", () => {
  it("round-trips", () => {
    const t = signUnpublishToken("post-1", "secret-a");
    expect(verifyUnpublishToken("post-1", t, "secret-a")).toBe(true);
  });
  it("rejects wrong post, wrong secret, garbage", () => {
    const t = signUnpublishToken("post-1", "secret-a");
    expect(verifyUnpublishToken("post-2", t, "secret-a")).toBe(false);
    expect(verifyUnpublishToken("post-1", t, "secret-b")).toBe(false);
    expect(verifyUnpublishToken("post-1", "zzzz", "secret-a")).toBe(false);
    expect(verifyUnpublishToken("post-1", "", "secret-a")).toBe(false);
  });
});
