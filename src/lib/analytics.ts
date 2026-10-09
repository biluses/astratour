/** Drop query and hash before sending analytics: URLs carry tour ids (?tour=) and checkout state. */
export function stripQuery<T extends { url: string }>(event: T): T {
  const url = new URL(event.url);
  return { ...event, url: url.origin + url.pathname };
}
