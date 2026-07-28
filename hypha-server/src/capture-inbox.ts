/**
 * Capture inbox — on-disk mailbox for clips from the Firefox/Thunderbird
 * extensions.
 *
 * The inbox never touches the graph. Hypha's graph lives in the browser's
 * OPFS and only reaches the server through RTC sync, so a server-side graph
 * write would have to go through the sync pipeline. Instead clips are
 * parked here and the browser drains them on its next boot, writing the
 * blocks through the ordinary client path.
 *
 * Delivery is at-least-once: a clip stays in the inbox until the client
 * acks it *after* inserting the block. A crash mid-drain therefore replays
 * a clip rather than losing it.
 *
 * Storage is a single JSON file under HYPHA_DATA_DIR. Hypha is single-user
 * and clips arrive a handful of times a day, so a rewrite-on-change file is
 * the right size of solution; writes are serialised through one promise
 * chain because Node interleaves awaits.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface Clip {
  id: string;
  title?: string;
  text?: string;
  url?: string;
  /** Unix ms at which the extension handed the clip over. */
  capturedAt: number;
}

/** The clip fields an extension may submit. */
export interface ClipInput {
  title?: string;
  text?: string;
  url?: string;
}

const INBOX_FILENAME = "capture-inbox.json";

export class CaptureInbox {
  private readonly path: string;
  /** Serialises read-modify-write cycles. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, INBOX_FILENAME);
  }

  private async read(): Promise<Clip[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Clip[];
    } catch (err) {
      // First clip on a fresh instance: no file yet.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async write(clips: Clip[]): Promise<void> {
    // Write-then-rename so a crash mid-write cannot leave a truncated
    // inbox behind — the clips are the user's only copy at this point.
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(clips), "utf8");
    await rename(tmp, this.path);
  }

  /** Run `fn` with exclusive access to the inbox file. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  add(input: ClipInput): Promise<Clip> {
    return this.serialise(async () => {
      const clip: Clip = {
        id: randomUUID(),
        ...(input.title ? { title: input.title } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.url ? { url: input.url } : {}),
        capturedAt: Date.now(),
      };
      const clips = await this.read();
      clips.push(clip);
      await this.write(clips);
      return clip;
    });
  }

  /** All undrained clips, oldest first. */
  list(): Promise<Clip[]> {
    return this.serialise(() => this.read());
  }

  /** Drop the given clips; returns how many are left. Unknown ids are ignored. */
  ack(ids: string[]): Promise<number> {
    return this.serialise(async () => {
      const drop = new Set(ids);
      const remaining = (await this.read()).filter((clip) => !drop.has(clip.id));
      await this.write(remaining);
      return remaining.length;
    });
  }
}
