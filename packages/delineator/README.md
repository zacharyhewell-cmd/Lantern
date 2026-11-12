# Delineator optimizer

Delineator is a TypeScript library for planning warehouse allocation, rigid carton packing, shipment splits, and comparative shipping costs. Import `planShipments` and its input and result types from `@lantern/delineator`. Callers supply a normalized order, inventory snapshot, and any rate configuration or known-combination store. Carton fit uses geometry, and rate scoring uses available item weights. The library has no third-party runtime dependencies.

Lantern provides the DV1 operator workflow and owns the Shopify, Surpath, and Feishu connections. From the Lantern root, run `npm test` to build and test both layers, or `npm run plan:dv1` to exercise the DV1 planning path with fixtures.

The package build emits JavaScript and declarations into `dist`. Its public entry point is `src/index.ts`.
