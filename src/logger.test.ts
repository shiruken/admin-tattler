import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, logger } from "./logger.js";

describe("logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes debug logs and calls console.debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const customLogger = createLogger("action");

    customLogger.debug("test debug message", { extra: 1 });
    expect(debugSpy).toHaveBeenCalledWith("[action] test debug message", { extra: 1 });
  });

  it("prefixes info logs and calls console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const customLogger = createLogger("notify");

    customLogger.info("test info message");
    expect(logSpy).toHaveBeenCalledWith("[notify] test info message");
  });

  it("prefixes warn logs and calls console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const customLogger = createLogger("modlist");

    customLogger.warn("test warn message");
    expect(warnSpy).toHaveBeenCalledWith("[modlist] test warn message");
  });

  it("prefixes error logs and calls console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const customLogger = createLogger("cache");

    const err = new Error("redis failure");
    customLogger.error("test error message", err);
    expect(errorSpy).toHaveBeenCalledWith("[cache] test error message", err);
  });

  it("provides pre-configured loggers for all domains", () => {
    expect(logger.action).toBeDefined();
    expect(logger.notify).toBeDefined();
    expect(logger.modlist).toBeDefined();
    expect(logger.cache).toBeDefined();
    expect(logger.app).toBeDefined();
  });
});
