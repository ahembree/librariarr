/**
 * Reads the Settings page starts on a section's behalf: the page asks for a
 * section's opening data with its tab's other loaders (so the tab renders only
 * once that data is in, and the read is answered by the settings bundle), and
 * the section, which fetches its own data when it mounts, is handed that
 * answer — once. Every later read, on a remount or after a change, is a
 * request of its own.
 */
export interface PreloadedReads {
  /** Start `path`'s read now; resolves once it has answered (failures included). */
  preload(path: string): Promise<void>;
  /** The preloaded answer the first time; otherwise `read(path)`. */
  get(path: string): Promise<Response>;
}

export function createPreloadedReads(read: (path: string) => Promise<Response>): PreloadedReads {
  const pending = new Map<string, Promise<Response>>();
  return {
    preload(path) {
      let response = pending.get(path);
      if (!response) {
        response = read(path);
        pending.set(path, response);
      }
      return response.then(
        () => undefined,
        () => undefined,
      );
    },
    get(path) {
      const response = pending.get(path);
      if (!response) return read(path);
      // A response body can be read once, so it goes to the first reader only.
      pending.delete(path);
      return response;
    },
  };
}
