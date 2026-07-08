import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLanternReply,
  isLanternMisspellingTrigger,
  isLanternRequestTrigger,
  isLanternTrigger,
  LANTERN_SPELLING_REPLY,
} from "../src/lantern/reply.js";

test("recognizes Lantern trigger without changing case rules", () => {
  assert.equal(isLanternTrigger("Lantern 32303"), true);
  assert.equal(isLanternTrigger("lantern WS-#32303"), true);
  assert.equal(isLanternTrigger("hey Lantern 32303"), false);
});

test("recognizes near misspellings only at the start of a Lantern request", () => {
  assert.equal(isLanternMisspellingTrigger("Lanter 32303"), true);
  assert.equal(isLanternMisspellingTrigger("Lantren WS-#32303"), true);
  assert.equal(isLanternMisspellingTrigger("Lannttern 32303"), true);
  assert.equal(isLanternMisspellingTrigger("Lantern 32303"), false);
  assert.equal(isLanternMisspellingTrigger("hey Lanter 32303"), false);
  assert.equal(isLanternMisspellingTrigger("Watchtower refresh"), false);
});

test("treats near misspellings as Lantern-class request triggers", () => {
  assert.equal(isLanternRequestTrigger("Lantern 32303"), true);
  assert.equal(isLanternRequestTrigger("Lanter 32303"), true);
  assert.equal(isLanternRequestTrigger("hello"), false);
});

test("returns spelling reply for near misspellings without running lookup", async () => {
  const reply = await buildLanternReply("Lantren 32303", {
    shopifyConfig: {},
    surpathConfig: {},
    fedExConfig: {},
  });

  assert.equal(reply, LANTERN_SPELLING_REPLY);
});
