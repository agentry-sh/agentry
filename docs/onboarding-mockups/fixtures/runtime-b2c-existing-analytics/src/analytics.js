export function createProductAnalytics() {
  const events = [];
  let sequence = 0;

  return {
    track(event, properties = {}) {
      sequence += 1;
      const entry = {
        sequence,
        event: String(event),
        properties: { ...properties },
      };
      events.push(entry);
      return entry;
    },
    list() {
      return events.map((entry) => ({
        ...entry,
        properties: { ...entry.properties },
      }));
    },
  };
}
