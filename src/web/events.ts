/** What changed on the server; the page then asks for the data itself (nothing sensitive travels in an event). */
export type Topic = 'sync' | 'preview' | 'google' | 'service' | 'settings';

/** An in-process fan-out of "this topic changed" to the open event streams. */
export class EventBus {
  private readonly listeners = new Set<(t: Topic) => void>();

  emit(topic: Topic): void {
    for (const l of [...this.listeners]) {
      try {
        l(topic);
      } catch {
        /* a broken stream must never stop the others */
      }
    }
  }

  subscribe(fn: (t: Topic) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.listeners.size;
  }
}
