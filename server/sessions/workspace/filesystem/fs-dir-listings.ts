import { randomBytes } from "node:crypto";
import type { FsDirEntry } from "../../../protocol";
import { FS_DIR_MAX_SCAN_ENTRIES, openDirRaw, sortAndCapDir, type RawDirectory } from "./fs-folder-tree";

const UNAVAILABLE = "This folder listing is no longer available. Refresh files to continue.";
const MAX_LISTINGS = 32;
const LISTING_TTL_MS = 120_000;
type Decoration = (entries: FsDirEntry[]) => FsDirEntry[];

type Listing = {
  scope: object;
  root: string;
  path: string;
  raw: RawDirectory;
  pending: FsDirEntry[];
  done: boolean;
  decorate?: Decoration;
  // One yield per Git record visited, including records that produce no row.
  extra?: Iterator<FsDirEntry | undefined>;
  token?: string;
  timer?: ReturnType<typeof setTimeout>;
};

/** One connection's bounded directory handles and unsent page tails. Tokens
 * are single-use, and a fresh listing of a path invalidates its old cursor. */
export class DirectoryListings {
  private active = new Set<Listing>();
  private tokens = new Map<string, Listing>();
  private scope?: object;

  constructor(private limits: {
    maxScanEntries?: number;
    maxEntries?: number;
    maxNameBytes?: number;
    maxListings?: number;
    ttlMs?: number;
  } = {}) {}

  clear(): void {
    for (const listing of this.active) this.close(listing);
    this.scope = undefined;
  }

  private enter(scope: object): void {
    if (scope !== this.scope) this.clear();
    this.scope = scope;
  }

  has(listing: Listing): boolean { return this.active.has(listing); }

  close(listing: Listing): void {
    clearTimeout(listing.timer);
    listing.raw.close();
    listing.pending = [];
    listing.extra = undefined;
    listing.decorate = undefined;
    this.active.delete(listing);
    if (listing.token) this.tokens.delete(listing.token);
  }

  cancel(token: unknown): void {
    const listing = typeof token === "string" ? this.tokens.get(token) : undefined;
    if (listing) this.close(listing);
  }

  private arm(listing: Listing): void {
    clearTimeout(listing.timer);
    listing.timer = setTimeout(() => this.close(listing), this.limits.ttlMs ?? LISTING_TTL_MS);
    listing.timer.unref();
  }

  open(scope: object, root: string, rel: string): Listing {
    this.enter(scope);
    const path = rel === "." ? "" : rel;
    for (const listing of this.active) {
      if (listing.path === path) this.close(listing);
    }
    while (this.active.size >= (this.limits.maxListings ?? MAX_LISTINGS)) {
      this.close(this.active.values().next().value!);
    }
    const raw = openDirRaw(root, path, this.limits.maxScanEntries);
    const listing: Listing = {
      scope, root, path, raw, pending: [], done: false,
    };
    this.active.add(listing);
    this.arm(listing);
    return listing;
  }

  resume(scope: object, root: string, rel: string, token: unknown): Listing {
    this.enter(scope);
    const listing = typeof token === "string" && /^[a-f0-9]{48}$/.test(token)
      ? this.tokens.get(token) : undefined;
    if (!listing) throw new Error(UNAVAILABLE);
    this.tokens.delete(listing.token!);
    listing.token = undefined;
    if (listing.scope !== scope || listing.root !== root || listing.path !== (rel === "." ? "" : rel)) {
      this.close(listing);
      throw new Error(UNAVAILABLE);
    }
    return listing;
  }

  page(listing: Listing): { entries: FsDirEntry[]; truncated?: true; continuation?: string } {
    if (!this.has(listing)) throw new Error(UNAVAILABLE);
    try {
      if (listing.token) this.tokens.delete(listing.token);
      listing.token = undefined;
      listing.raw.check();
      if (!listing.pending.length) {
        let remaining = Math.max(1, Math.min(this.limits.maxScanEntries ?? FS_DIR_MAX_SCAN_ENTRIES, FS_DIR_MAX_SCAN_ENTRIES));
        if (!listing.done) {
          const raw = listing.raw.read();
          listing.done = raw.done;
          listing.pending = listing.decorate?.(raw.all) ?? raw.all;
          remaining -= raw.scanned;
        }
        // Deleted rows share the raw scan's work budget. On-disk duplicates
        // have already been enumerated; checks stay lazy even for huge indexes.
        while (listing.done && listing.extra && remaining-- > 0) {
          const next = listing.extra.next();
          if (next.done) listing.extra = undefined;
          else if (next.value) listing.pending.push(next.value);
        }
      }
      const result = sortAndCapDir(listing.pending, this.limits);
      if (!result.entries.length && listing.pending.length) {
        throw new Error("A directory entry exceeds the listing size limit.");
      }
      const sent = new Set(result.entries);
      listing.pending = listing.pending.filter(entry => !sent.has(entry));
      if (!listing.pending.length && listing.done && !listing.extra) {
        this.close(listing);
        return { entries: result.entries };
      }
      listing.token = randomBytes(24).toString("hex");
      this.tokens.set(listing.token, listing);
      this.arm(listing);
      return { entries: result.entries, truncated: true, continuation: listing.token };
    } catch (err) {
      this.close(listing);
      throw err;
    }
  }
}
