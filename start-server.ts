import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { handler } from "./server.js";
import { withX402Gate } from "./lib/x402/gate.js";
import { buildDiscoveryResponse } from "./lib/x402/challenge.js";
import { FREE_TOOL_NAMES, PAID_TOOL_NAMES, TOOL_PRICES, getAtlasConfig } from "./lib/x402/config.js";
import { getAtlasLimits } from "./lib/atlas/schemas.js";
import { validateArtifactStorage } from "./lib/atlas/artifacts.js";
import { validateAtlasSignerConfiguration } from "./lib/atlas/report.js";
import { getOgConfig } from "./lib/og/config.js";
import { sandboxStatuses } from "./lib/sandbox/e2b.js";

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

// Validate every environment-backed subsystem before binding a listening socket.
const atlasLimits = getAtlasLimits();
const atlasConfig = getAtlasConfig();
const atlasSignerStatus = validateAtlasSignerConfiguration();
const artifactStorageStatus = await validateArtifactStorage();
const ogConfig = getOgConfig();
const gatedHandler = withX402Gate(handler);

class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) output.append(key, item);
    else if (value !== undefined) output.set(key, value);
  }
  return output;
}

function preflightContentLength(request: IncomingMessage, maxBytes: number): void {
  const header = request.headers["content-length"];
  if (header === undefined) return;
  const values = Array.isArray(header) ? header : [header];
  for (const value of values) {
    const normalized = value.trim();
    if (/^\d+$/.test(normalized) && BigInt(normalized) > BigInt(maxBytes)) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const maxBytes = atlasLimits.maxRequestBytes;
  preflightContentLength(request, maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new PayloadTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const controller = new AbortController();
  request.on("aborted", () => controller.abort());
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  return new Request(url, {
    method: request.method || "GET",
    headers: toWebHeaders(request.headers),
    body,
    signal: controller.signal,
  });
}

async function waitForDrain(output: ServerResponse): Promise<void> {
  if (output.destroyed || output.writableEnded) {
    throw new Error("HTTP client disconnected before the response was written");
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("close", onClose);
      output.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("HTTP client disconnected before the response was written"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    output.once("drain", onDrain);
    output.once("close", onClose);
    output.once("error", onError);
  });
}

async function send(response: Response, output: ServerResponse): Promise<void> {
  output.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { output.end(); return; }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!output.write(value)) await waitForDrain(output);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    if (!output.writableEnded && !output.destroyed) output.end();
  }
}

function cors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, PAYMENT-SIGNATURE");
  response.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendPayloadTooLarge(error: PayloadTooLargeError, response: ServerResponse): void {
  if (!response.headersSent) {
    response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
  }
  if (!response.writableEnded) {
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "Request payload too large",
        data: { maxRequestBytes: error.maxBytes },
      },
    }));
  }
}

const server = createServer(async (request, response) => {
  cors(response);
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const path = new URL(request.url || "/", `http://127.0.0.1:${PORT}`).pathname;

  if (path === "/" || path === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      ok: true,
      service: "evidiq-atlas-mcp",
      version: "0.1.0",
      duckdb: true,
      x402: atlasConfig !== null,
      reportSigner: {
        configured: atlasSignerStatus.configured,
        signingEnabled: atlasSignerStatus.signingEnabled,
        verificationEnabled: atlasSignerStatus.verificationEnabled,
        ...(atlasSignerStatus.signer ? { signer: atlasSignerStatus.signer } : {}),
        ...(atlasSignerStatus.trustedSigner ? { trustedSigner: atlasSignerStatus.trustedSigner } : {}),
      },
      artifactStorage: { ready: artifactStorageStatus.ready },
      storage: { provider: "0G", configured: ogConfig !== null },
      sandboxProviders: sandboxStatuses(),
    }));
    return;
  }

  if (path === "/skill.md") {
    try {
      const skill = await readFile(new URL("../skill.md", import.meta.url), "utf8");
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" });
      response.end(skill);
    } catch (error) {
      console.error("Failed to serve skill.md", error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Skill document is unavailable" }));
    }
    return;
  }

  if (path === "/x402") {
    if (atlasConfig) { await send(buildDiscoveryResponse(atlasConfig), response); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      x402: false,
      note: "X402_PAY_TO is unset; all tools are ungated. Set X402_PAY_TO to enable x402 payment.",
      pricing: [
        ...PAID_TOOL_NAMES.map((tool) => ({ tool, amount: TOOL_PRICES[tool].toString(), usd: Number(TOOL_PRICES[tool]) / 1_000_000 })),
        ...FREE_TOOL_NAMES.map((tool) => ({ tool, amount: "0", usd: 0, free: true })),
      ],
    }, null, 2));
    return;
  }

  if (!["/mcp", "/sse", "/message"].includes(path)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  // HEAD must answer with the status a GET would return and no body. The MCP
  // Streamable-HTTP transport cannot serve HEAD, so a HEAD forwarded to it never
  // completes — the connection just hangs and a reachability prober reports the
  // endpoint as offline. Answer it here instead.
  if (request.method === "HEAD") {
    response.writeHead(atlasConfig ? 402 : 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      allow: "POST, OPTIONS, HEAD",
    });
    response.end();
    return;
  }

  try {
    await send(await gatedHandler(await toWebRequest(request)), response);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendPayloadTooLarge(error, response);
      return;
    }
    console.error("Atlas request failed", error);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`EVIDIQ Atlas MCP listening on http://${HOSTNAME}:${PORT}`);
  console.log(`MCP endpoint: http://${HOSTNAME}:${PORT}/mcp`);
});
