/** Shared provider-resume identity state. Providers decide when an id becomes
 * safe to persist; this helper only owns change detection and observation. */
export class ResumeIdState {
  private listeners = new Set<(id: string) => void>();

  constructor(private current?: string) {}

  get value(): string | undefined {
    return this.current;
  }

  onChange(cb: (id: string) => void, current = this.current) {
    this.listeners.add(cb);
    if (current) cb(current);
  }

  publish(id: string) {
    if (this.current === id) return;
    this.current = id;
    for (const cb of this.listeners) cb(id);
  }
}
