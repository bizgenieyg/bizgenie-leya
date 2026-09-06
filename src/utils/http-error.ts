export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: { status: string; qrAvailable: boolean },
  ) {
    super(message);
    this.name = "HttpError";
  }
}
