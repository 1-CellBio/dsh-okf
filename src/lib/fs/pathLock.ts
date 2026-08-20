const tails = new Map<string, Promise<void>>();

/** Serialize async work that read-modify-writes the same bundle path. */
export async function withPathLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const key = path.replace(/^\/+/, "").replace(/\\/g, "/");
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = tails.get(key) ?? Promise.resolve();
  const tail = prev.then(() => done);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  }
}
