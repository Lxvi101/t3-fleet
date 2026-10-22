import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryEntry } from "./model.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** In-memory ring of recent fleet activity, mirrored to an append-only JSONL file. */
export class HistoryStore {
  private entries: HistoryEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(entry: HistoryEntry) => void>();

  constructor(
    private readonly file: string | null,
    private readonly capacity = 2000,
  ) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-capacity);
    for (const line of lines) {
      try {
        this.entries.push(JSON.parse(line));
      } catch {}
    }
    this.nextId = (this.entries.at(-1)?.id ?? 0) + 1;
    if (statSync(file).size > MAX_FILE_BYTES) this.compact();
  }

  add(entry: Omit<HistoryEntry, "id" | "at"> & { at?: string }) {
    const full: HistoryEntry = { id: this.nextId++, at: entry.at ?? new Date().toISOString(), ...entry } as HistoryEntry;
    this.entries.push(full);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    if (this.file) {
      try {
        appendFileSync(this.file, `${JSON.stringify(full)}\n`);
      } catch {}
    }
    for (const listener of this.listeners) listener(full);
  }

  recent(limit = 300): HistoryEntry[] {
    return this.entries.slice(-limit);
  }

  subscribe(listener: (entry: HistoryEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private compact() {
    if (!this.file) return;
    writeFileSync(this.file, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
}
