import test from "node:test";
import assert from "node:assert/strict";
import { isLanternTrigger } from "../src/lantern/reply.js";

test("recognizes Lantern trigger without changing case rules", () => {
  assert.equal(isLanternTrigger("Lantern 32303"), true);
  assert.equal(isLanternTrigger("lantern WS-#32303"), true);
  assert.equal(isLanternTrigger("hey Lantern 32303"), false);
});
