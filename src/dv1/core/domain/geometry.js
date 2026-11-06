function volume(dimensions) {
  return dimensions.length * dimensions.width * dimensions.height;
}
function sortedSides(dimensions) {
  return [dimensions.length, dimensions.width, dimensions.height].sort((a, b) => a - b);
}
function canFitByRotation(item, container) {
  const itemSides = sortedSides(item);
  const containerSides = sortedSides(container);
  return itemSides.every((side, index) => side <= containerSides[index]);
}
function packRigidItems(lines, container) {
  const items = expandLineItems(lines).sort((a, b) => volume(b.dimensions) - volume(a.dimensions));
  const placed = [];
  const candidates = [{ x: 0, y: 0, z: 0 }];
  for (const item of items) {
    let placement = null;
    for (const candidate of sortCandidatePositions(candidates)) {
      for (const orientation of uniqueOrientations(item.dimensions)) {
        const proposed = { sku: item.sku, dimensions: orientation, position: candidate };
        if (fitsInside(proposed, container) && !placed.some((existing) => overlaps(proposed, existing))) {
          placement = proposed;
          break;
        }
      }
      if (placement) {
        break;
      }
    }
    if (!placement) {
      return null;
    }
    placed.push(placement);
    candidates.push(
      { x: placement.position.x + placement.dimensions.length, y: placement.position.y, z: placement.position.z },
      { x: placement.position.x, y: placement.position.y + placement.dimensions.width, z: placement.position.z },
      { x: placement.position.x, y: placement.position.y, z: placement.position.z + placement.dimensions.height }
    );
  }
  return placed;
}
function totalLineVolume(lines) {
  return lines.reduce((sum, line) => sum + volume(requiredDimensions(line)) * line.quantity, 0);
}
function shipmentVolume(lines, sourceLines) {
  return lines.reduce((sum, shipmentLine) => {
    const source = sourceLines.find((line) => line.id === shipmentLine.orderLineId);
    return source ? sum + volume(requiredDimensions(source)) * shipmentLine.quantity : sum;
  }, 0);
}
function requiredDimensions(line) {
  if (!line.dimensions) {
    throw new Error(`Missing dimensions for ${line.sku}`);
  }
  return line.dimensions;
}
function expandLineItems(lines) {
  return lines.flatMap(
    (line) => Array.from({ length: line.quantity }, () => ({
      sku: line.sku,
      dimensions: requiredDimensions(line)
    }))
  );
}
function uniqueOrientations(dimensions) {
  const { length, width, height, unit } = dimensions;
  const orientations = [
    [length, width, height],
    [length, height, width],
    [width, length, height],
    [width, height, length],
    [height, length, width],
    [height, width, length]
  ];
  const seen = /* @__PURE__ */ new Set();
  return orientations.flatMap(([orientationLength, orientationWidth, orientationHeight]) => {
    const key = `${orientationLength}:${orientationWidth}:${orientationHeight}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        length: orientationLength,
        width: orientationWidth,
        height: orientationHeight,
        unit
      }
    ];
  });
}
function sortCandidatePositions(candidates) {
  const unique = new Map(candidates.map((candidate) => [`${candidate.x}:${candidate.y}:${candidate.z}`, candidate]));
  return [...unique.values()].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
}
function fitsInside(item, container) {
  return item.position.x + item.dimensions.length <= container.length && item.position.y + item.dimensions.width <= container.width && item.position.z + item.dimensions.height <= container.height;
}
function overlaps(a, b) {
  return a.position.x < b.position.x + b.dimensions.length && a.position.x + a.dimensions.length > b.position.x && a.position.y < b.position.y + b.dimensions.width && a.position.y + a.dimensions.width > b.position.y && a.position.z < b.position.z + b.dimensions.height && a.position.z + a.dimensions.height > b.position.z;
}
export {
  canFitByRotation,
  packRigidItems,
  requiredDimensions,
  shipmentVolume,
  sortedSides,
  totalLineVolume,
  volume
};
