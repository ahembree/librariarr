/**
 * The longest termination delay (seconds) maintenance mode, the transcode
 * manager and a Warn Then Terminate blackout may wait before ending a stream.
 * Client-safe: the Stream Manager inputs and the validation schemas share it,
 * so the page cannot offer less (or more) than the API accepts.
 */
export const MAX_TERMINATION_DELAY_SECONDS = 3600;
