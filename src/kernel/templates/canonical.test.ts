import { describe, expect, it } from "vitest";
import { frameHash, inputDigest } from "./canonical.js";
import type { InputV2 } from "./types.js";

const minimal: InputV2 = { authority: [], placement: [], version: 2 };

describe("InputV2 canonical identity", () => {
  it("pins the approved minimal frame bytes and digest", () => {
    expect(Buffer.from(frameHash("oms.template-migration.input.v2", minimal)).toString("hex")).toBe(
      "6f6d732d686173682d6672616d652d7631003331006f6d732e74656d706c6174652d6d6967726174696f6e2e696e7075742e76323433007b22617574686f72697479223a5b5d2c22706c6163656d656e74223a5b5d2c2276657273696f6e223a327d",
    );
    expect(inputDigest(minimal)).toBe("sha256:0128ccd458153516abd0e9d49f6210a3034b71e73e0750eb652807294ab13642");
  });
});
