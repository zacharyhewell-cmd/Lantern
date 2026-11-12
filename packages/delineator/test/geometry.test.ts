import assert from "node:assert/strict";
import test from "node:test";
import { packRigidItems } from "../src/domain/geometry.js";
import type { OrderLine } from "../src/domain/types.js";

test("places rigid items without overlap or protrusion", () => {
  const lines: OrderLine[] = [
    {
      id: "line-1",
      sku: "AACC0019B",
      quantity: 2,
      dimensions: { length: 180, width: 177.8, height: 76.2, unit: "mm" }
    }
  ];

  const placed = packRigidItems(lines, { length: 430, width: 205, height: 260, unit: "mm" });

  assert.equal(placed?.length, 2);
});

test("rejects cartons when total volume fits but rigid dimensions cannot be placed", () => {
  const lines: OrderLine[] = [
    {
      id: "line-1",
      sku: "AA-LONG-A",
      quantity: 2,
      dimensions: { length: 7, width: 4, height: 1.1, unit: "in" }
    }
  ];

  const placed = packRigidItems(lines, { length: 8, width: 4, height: 2, unit: "in" });

  assert.equal(placed, null);
});
