/**
 * An error that already knows its HTTP answer. `route()` in index.ts sends
 * `status` with `publicMessage` (scrubbed), and logs `message` — which may
 * carry detail the user should not see, such as a jose reason.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly publicMessage: string = message,
  ) {
    super(message);
  }
}
