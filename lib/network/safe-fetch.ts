import { promises as dns } from "node:dns";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import type { DatasetFormat } from "../atlas/schemas.js";

export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type SafeUrlInspection = Readonly<{
  normalizedUrl: string;
  hostname: string;
  addresses: readonly ResolvedAddress[];
}>;
export type SafeFetchResult = Readonly<{
  bytes: Buffer;
  finalUrl: string;
  contentType: string;
  address: ResolvedAddress;
  redirects: number;
}>;

const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);

const IPV4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

const IPV6_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], ["::ffff:0:0", 96], ["3fff::", 20], ["5f00::", 16],
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10],
  ["fec0::", 10], ["ff00::", 8],
];

function parseIpv4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    result = (result << 8n) | BigInt(number);
  }
  return result;
}

function parseIpv6(input: string): bigint | null {
  let value = input.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes("%")) return null;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, lastColon)}:${((ipv4 >> 16n) & 0xffffn).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = value.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const hasCompression = value.includes("::");
  if ((!hasCompression && left.length !== 8) || (hasCompression && left.length + right.length >= 8)) return null;
  const fill = hasCompression ? new Array(8 - left.length - right.length).fill("0") : [];
  const parts = [...left, ...fill, ...right];
  if (parts.length !== 8) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    result = (result << 16n) | BigInt(`0x${part}`);
  }
  return result;
}

function inCidr(value: bigint, network: bigint, prefix: number, bits: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (network >> shift);
}

export function isProhibitedIp(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) {
    const value = parseIpv4(address);
    if (value === null) return true;
    return IPV4_BLOCKS.some(([network, prefix]) => {
      const parsed = parseIpv4(network);
      return parsed !== null && inCidr(value, parsed, prefix, 32);
    });
  }
  if (family === 6) {
    const value = parseIpv6(address);
    if (value === null) return true;
    const mappedPrefix = parseIpv6("::ffff:0:0");
    if (mappedPrefix !== null && inCidr(value, mappedPrefix, 96, 128)) {
      const mapped = [Number((value >> 24n) & 255n), Number((value >> 16n) & 255n), Number((value >> 8n) & 255n), Number(value & 255n)].join(".");
      return isProhibitedIp(mapped);
    }
    return IPV6_BLOCKS.some(([network, prefix]) => {
      const parsed = parseIpv6(network);
      return parsed !== null && inCidr(value, parsed, prefix, 128);
    });
  }
  return true;
}

function parseSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Dataset URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP(S) dataset URLs are allowed");
  }
  if (url.username || url.password) throw new Error("Dataset URLs cannot contain credentials");
  if (url.hash) throw new Error("Dataset URLs cannot contain fragments");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new Error("Local or metadata hostnames are not allowed");
  }
  if (url.port) {
    const allowed = (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80");
    if (!allowed) throw new Error("Only the default HTTP(S) port is allowed");
  }
  return url;
}

function lookupAllWithTimeout(hostname: string, timeoutMs: number): Promise<ResolvedAddress[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Dataset DNS resolution timed out"));
  }
  const duration = Math.min(Math.max(1, Math.ceil(timeoutMs)), MAX_TIMER_MS);
  const deadline = Date.now() + duration;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Dataset DNS resolution timed out"));
    }, duration);

    void dns.lookup(hostname, { all: true, verbatim: true }).then(
      (items) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (Date.now() >= deadline) {
          reject(new Error("Dataset DNS resolution timed out"));
          return;
        }
        resolve(items.map((item) => ({ address: item.address, family: item.family as 4 | 6 })));
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function inspectSafeUrl(rawUrl: string, timeoutMs = DEFAULT_DNS_TIMEOUT_MS): Promise<SafeUrlInspection> {
  const url = parseSafeUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const resolved: ResolvedAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookupAllWithTimeout(hostname, timeoutMs);
  if (resolved.length === 0) throw new Error("Dataset hostname did not resolve");
  for (const address of resolved) {
    if (isProhibitedIp(address.address)) {
      throw new Error(`Dataset hostname resolves to a prohibited address (${address.address})`);
    }
  }
  const unique = Array.from(new Map(resolved.map((item) => [`${item.family}:${item.address}`, item])).values())
    .sort((a, b) => a.family - b.family || a.address.localeCompare(b.address));
  return { normalizedUrl: url.toString(), hostname, addresses: unique };
}

export function createPinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

const CONTENT_TYPES: Record<DatasetFormat, ReadonlySet<string>> = {
  csv: new Set(["text/csv", "application/csv", "text/plain", "application/octet-stream"]),
  json: new Set(["application/json", "text/json", "text/plain", "application/octet-stream"]),
  ndjson: new Set(["application/x-ndjson", "application/ndjson", "application/jsonlines", "text/plain", "application/octet-stream"]),
  parquet: new Set(["application/vnd.apache.parquet", "application/x-parquet", "application/octet-stream"]),
};

function normalizedContentType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error(`Dataset exceeds the ${maxBytes}-byte decompressed limit`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function decodedStream(response: IncomingMessage): Readable {
  const encoding = (response.headers["content-encoding"] ?? "identity").toString().trim().toLowerCase();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  throw new Error(`Unsupported content encoding: ${encoding}`);
}

function requestOnce(url: URL, pinned: ResolvedAddress, remainingMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      family: pinned.family,
      headers: {
        accept: "text/csv, application/json, application/x-ndjson, application/vnd.apache.parquet, application/octet-stream;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "EVIDIQ-Atlas/0.1",
      },
      lookup: createPinnedLookup(pinned),
    };
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(options, resolve);
    const timer = setTimeout(() => request.destroy(new Error("Dataset fetch timed out")), Math.max(1, remainingMs));
    request.once("error", reject);
    request.once("close", () => clearTimeout(timer));
    request.end();
  });
}

export async function safeFetchDataset(
  rawUrl: string,
  format: DatasetFormat,
  options: Readonly<{ maxBytes: number; timeoutMs: number; maxRedirects?: number }>
): Promise<SafeFetchResult> {
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const inspectionRemaining = deadline - Date.now();
    if (inspectionRemaining <= 0) throw new Error("Dataset fetch timed out");
    const inspection = await inspectSafeUrl(current, inspectionRemaining);
    const pinned = inspection.addresses[0];
    if (!pinned) throw new Error("Dataset hostname has no usable address");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Dataset fetch timed out");
    const response = await requestOnce(new URL(inspection.normalizedUrl), pinned, remaining);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error("Dataset redirect has no Location header");
      if (redirects === maxRedirects) throw new Error("Dataset redirect limit exceeded");
      current = new URL(location, inspection.normalizedUrl).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Dataset server returned HTTP ${status}`);
    }
    const contentLength = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      response.destroy();
      throw new Error(`Dataset Content-Length exceeds the ${options.maxBytes}-byte limit`);
    }
    const contentType = normalizedContentType(response.headers["content-type"]?.toString());
    if (!contentType || !CONTENT_TYPES[format].has(contentType)) {
      response.destroy();
      throw new Error(`Content-Type ${contentType || "(missing)"} is not accepted for ${format}`);
    }
    const bytes = await readLimited(decodedStream(response), options.maxBytes);
    return {
      bytes,
      finalUrl: inspection.normalizedUrl,
      contentType,
      address: pinned,
      redirects,
    };
  }
  throw new Error("Dataset redirect limit exceeded");
}
