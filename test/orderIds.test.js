import test from "node:test";
import assert from "node:assert/strict";
import { extractOrderIdentifier, normalizeOrderIdentifier } from "../src/orderIds.js";

test("extracts WS order IDs from Lantern messages", () => {
  assert.deepEqual(extractOrderIdentifier("Lantern tracking WS-#12345"), {
    raw: "WS-#12345",
    number: "12345",
    canonical: "WS-#12345",
    candidates: ["WS-#12345", "WS-12345", "#12345", "12345"],
  });
});

test("extracts lowercase WS order IDs and normalizes candidates", () => {
  assert.equal(extractOrderIdentifier("Lantern tracking ws-99954").canonical, "WS-#99954");
});

test("extracts plain numeric order IDs", () => {
  assert.deepEqual(normalizeOrderIdentifier("12345"), {
    raw: "12345",
    number: "12345",
    canonical: "12345",
    candidates: ["#12345", "WS-#12345", "WS-12345", "12345"],
  });
});

test("extracts order ID when message is only trigger plus number", () => {
  assert.equal(extractOrderIdentifier("Lantern 29690").canonical, "29690");
  assert.equal(extractOrderIdentifier("lantern WS-#29690").canonical, "WS-#29690");
});

test("accepts case-insensitive Lantern trigger at start of message", () => {
  assert.equal(extractOrderIdentifier("lantern tracking 12345").canonical, "12345");
  assert.equal(extractOrderIdentifier("LANTERN tracking 12345").canonical, "12345");
});

test("ignores messages without Lantern trigger at start", () => {
  assert.equal(extractOrderIdentifier("hey Lantern tracking 12345"), null);
});
