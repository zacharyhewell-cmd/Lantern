const DESCRIPTION_LIMIT = 50;

export function truncateTrackingUpdate(description) {
  const characters = Array.from(description ?? "");
  if (characters.length <= DESCRIPTION_LIMIT) return description;

  return characters.slice(0, DESCRIPTION_LIMIT).join("") + "...";
}
