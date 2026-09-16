import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const TOKEN = "test-token";

describe("loadConfig", () => {
  it("refuses to build a config without PROXY_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(/PROXY_TOKEN is required/);
  });

  it("treats an empty PROXY_TOKEN as unset", () => {
    expect(() => loadConfig({ PROXY_TOKEN: "" })).toThrow(/PROXY_TOKEN is required/);
  });

  it("keeps the token when one is provided", () => {
    expect(loadConfig({ PROXY_TOKEN: TOKEN }).token).toBe(TOKEN);
  });

  it("reads settings from the passed env rather than process.env", () => {
    const cfg = loadConfig({ PROXY_TOKEN: TOKEN, PORT: "9001", HOST: "0.0.0.0" });
    expect(cfg.port).toBe(9001);
    expect(cfg.host).toBe("0.0.0.0");
  });

  it("falls back to defaults for unset numbers", () => {
    expect(loadConfig({ PROXY_TOKEN: TOKEN }).port).toBe(8787);
  });

  it("rejects a non-numeric number", () => {
    expect(() => loadConfig({ PROXY_TOKEN: TOKEN, PORT: "abc" })).toThrow(/PORT must be a number/);
  });
});
