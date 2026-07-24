import { promises as dns } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup, inspectSafeUrl, isProhibitedIp, safeFetchDataset } from "../lib/network/safe-fetch.js";
import { validateDatasetSource } from "../lib/atlas/ingest.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("safe dataset fetch boundaries", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::8.8.8.8", "3fff::1", "5f00::1", "fc00::1", "fe80::1", "fec0::1",
    "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
  ])("blocks non-public address %s", (address) => {
    expect(isProhibitedIp(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "allows globally routable address %s",
    (address) => expect(isProhibitedIp(address)).toBe(false)
  );

  it("returns the pinned address in single-address and all-address lookup forms", () => {
    expect.assertions(6);
    const lookup = createPinnedLookup({ address: "203.0.114.7", family: 4 });

    lookup("dataset.example", { all: false }, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe("203.0.114.7");
      expect(family).toBe(4);
    });

    lookup("dataset.example", { all: true }, (error, addresses, family) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: "203.0.114.7", family: 4 }]);
      expect(family).toBeUndefined();
    });
  });

  it.each([
    "ftp://example.com/data.csv",
    "https://user:pass@example.com/data.csv",
    "http://localhost/data.csv",
    "http://127.0.0.1/data.csv",
    "https://[::1]/data.csv",
    "https://example.com:8443/data.csv",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://example.com/data.csv#fragment",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(inspectSafeUrl(url)).rejects.toThrow();
  });

  it("applies a default wall-clock timeout to DNS inspection", async () => {
    vi.useFakeTimers();
    vi.spyOn(dns, "lookup").mockImplementation(
      (() => new Promise<never>(() => undefined)) as typeof dns.lookup
    );

    const inspection = inspectSafeUrl("https://dns-timeout.example/data.csv");
    const rejection = expect(inspection).rejects.toThrow("Dataset DNS resolution timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
  });

  it("charges DNS resolution against the safe fetch total deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(dns, "lookup").mockImplementation(
      (() => new Promise<never>(() => undefined)) as typeof dns.lookup
    );

    const fetch = safeFetchDataset("https://dns-timeout.example/data.csv", "csv", {
      maxBytes: 1_024,
      timeoutMs: 25,
    });
    const rejection = expect(fetch).rejects.toThrow("Dataset DNS resolution timed out");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("validates inline JSON and rejects malformed NDJSON without network access", async () => {
    await expect(validateDatasetSource({ kind: "inline", format: "json", data: "[{\"id\":1}]" }))
      .resolves.toMatchObject({ valid: true, fetchPerformed: false });
    await expect(validateDatasetSource({ kind: "inline", format: "ndjson", data: "{\"id\":1}\nnot-json" }))
      .resolves.toMatchObject({ valid: false });
  });

  it("rejects inline Parquet at schema validation", async () => {
    const result = await validateDatasetSource({ kind: "inline", format: "parquet", data: "PAR1" });
    expect(result.valid).toBe(false);
  });
});
