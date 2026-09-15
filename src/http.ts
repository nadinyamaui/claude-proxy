import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";

export function json(res: ServerResponse, status: number, body: unknown, onFlush?: () => void): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload, onFlush);
}

/** Constant-time bearer check. Returns true when the request may proceed. */
export function authorize(req: IncomingMessage): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization ?? "";
  const presented = Buffer.from(header.replace(/^Bearer /i, ""));
  const expected = Buffer.from(config.token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export class BodyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;

    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        // Stop buffering, but leave the socket up: destroying it here would
        // race the 413 and the client would see a reset instead of the error.
        // The caller closes the connection once the response has flushed.
        over = true;
        chunks.length = 0;
        req.pause();
        reject(new BodyError(`body exceeds ${config.maxBodyBytes} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyError("body is not valid JSON"));
      }
    });
  });
}
