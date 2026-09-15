import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Constant-time bearer check. Returns true when the request may proceed. */
export function authorize(req: IncomingMessage): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization ?? "";
  const presented = Buffer.from(header.replace(/^Bearer /i, ""));
  const expected = Buffer.from(config.token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export class BodyError extends Error {}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new BodyError(`body exceeds ${config.maxBodyBytes} bytes`));
        req.destroy();
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
