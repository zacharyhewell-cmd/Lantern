# DV1 planner core

These runtime JavaScript files are generated from the portable Delineator planner in `/Users/zacharyhewell/Documents/Delineator` for the first same-host DV1 deployment.

The planner remains a separate core boundary: it consumes normalized order, inventory, catalog, and cost data and does not know about Shopify, Surpath, Eccang, Feishu, or Render. When the planner stabilizes, extract this directory into a shared package instead of maintaining two copies by hand.
