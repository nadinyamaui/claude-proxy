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

/**
 * Constant-time bearer check. Returns true when the request may proceed.
 * There is no unauthenticated mode: `config.token` is always set, because
 * startup fails without it.
 */
export function authorize(req: IncomingMessage): boolean {
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

/** Buffers the request body, rejecting with a 413 BodyError past `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;

    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering, but leave the socket up: destroying it here would
        // race the 413 and the client would see a reset instead of the error.
        // The caller closes the connection once the response has flushed.
        over = true;
        chunks.length = 0;
        req.pause();
        reject(new BodyError(`body exceeds ${maxBytes} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(req, config.maxBodyBytes)).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyError("body is not valid JSON");
  }
}

/**
 * Parses a multipart/form-data body with the platform parser behind the
 * global `Response`, so file uploads need no dependency.
 */
export async function readMultipart(req: IncomingMessage, maxBytes: number): Promise<FormData> {
  const contentType = req.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new BodyError("expected a multipart/form-data body", 415);
  }
  const body = await readBody(req, maxBytes);
  try {
    return await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BodyError(`malformed multipart body: ${detail}`);
  }
}
