import { readFile } from "node:fs/promises";
import { InMemoryKnownCombinationStore } from "@lantern/delineator";
import { historicalKnownCombinationsPath, planDv1Data } from "../dv1/plan.js";

const args = process.argv.slice(2);
if (args.length !== 0 && args.length !== 2) {
  console.error("Usage: npm run plan:dv1 -- [<normalized-order.json> <inventory.json>]");
  process.exit(1);
}

const [orderPath, inventoryPath] = args.length === 2
  ? args
  : [
    new URL("../../test/fixtures/dv1/order.json", import.meta.url),
    new URL("../../test/fixtures/dv1/inventory.json", import.meta.url),
  ];
const [order, inventory, { records }] = await Promise.all(
  [orderPath, inventoryPath, historicalKnownCombinationsPath]
    .map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
const knownCombinations = new InMemoryKnownCombinationStore(records);
const result = await planDv1Data({ order, inventory }, { knownCombinations });
console.log(JSON.stringify(result.plan, null, 2));
