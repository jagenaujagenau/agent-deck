export function mergeRecentEvents<T extends { id: string; createdAt: string }>(previous: T[], incoming: T[], limit = 500): T[] {
  const byId = new Map<string, T>();
  for (const event of previous) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-limit);
}
