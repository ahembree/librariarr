/**
 * Thrown by the Tracearr importer's write path when the media server is no
 * longer mapped to the Tracearr server the run is importing from.
 *
 * A run reads `MediaServer.tracearrServerId` once and pages for minutes. The
 * server PUT re-points or unlinks the mapping and wipes the server's rows, and
 * without a check at write time the run went on storing the OLD source's plays
 * after that wipe — a stale stratum the new mapping then resumed below, and on a
 * Tracearr → Tracearr switch the same plays stored twice under two chain ids.
 * Kept in its own module so the recovery pass can recognise it without
 * importing the importer it is mocked against in tests.
 */
export class TracearrMappingChangedError extends Error {
  constructor(serverId: string) {
    super(
      `Media server ${serverId} is no longer mapped to the Tracearr server this ` +
        `import was reading from`,
    );
    this.name = "TracearrMappingChangedError";
  }
}
