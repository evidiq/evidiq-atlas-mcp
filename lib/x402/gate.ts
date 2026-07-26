import {
  build402Response,
  buildAccepts,
  encodePaymentResponseHeader,
} from "./challenge.js";
import {
  FREE_TOOLS,
  PAID_TOOLS,
  getAtlasConfig,
  priceForTool,
  type AtlasConfig,
} from "./config.js";
import { getVerifier, type PaymentVerifier } from "./facilitator.js";
import type { PaymentPayload, SettleResult } from "./types.js";
import { decodePaymentHeader } from "./verify.js";

export { FREE_TOOLS, PAID_TOOLS } from "./config.js";

const ACCEPT_BOTH = "application/json, text/event-stream";
const SETTLEMENT_CACHE_TTL_MS = 10 * 60_000;
const SETTLEMENT_CACHE_MAX_ENTRIES = 1_024;

type JsonRpcCall = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown } | null;
};

type PaidCall = {
  tool: string;
  message: JsonRpcCall;
};

/** How long a duplicate request waits for an in-flight settlement to resolve. */
const DUPLICATE_WAIT_MS = 25_000;

type PendingSettlement = Extract<SettleResult, { status: "pending" }>;
type CachedSettlement =
  | {
      kind: "settling";
      payer: string;
      fingerprint: string;
      expiresAt: number;
      /**
       * The single in-flight settlement for this authorization. A duplicate
       * request awaits this promise instead of being turned away, so one
       * authorization is settled exactly once and every caller holding it
       * still learns the real outcome.
       */
      settlement: Promise<SettleResult>;
    }
  | {
      kind: "checking";
      result: PendingSettlement;
      fingerprint: string;
      expiresAt: number;
    }
  | {
      kind: "result";
      result: SettleResult;
      fingerprint: string;
      expiresAt: number;
    };

const settlementCache = new Map<string, CachedSettlement>();

/** A paid response captured so it can be handed to more than one caller. */
type SerializedResponse = {
  status: number;
  headers: [string, string][];
  body: string;
};

/**
 * The single paid execution for one authorization, shared by every request that
 * carries it. Storing the *promise* — not just the finished response — is what
 * makes a concurrent duplicate safe: the second caller attaches to the run
 * already underway instead of starting the paid work a second time. One
 * authorization therefore means one charge, one execution, and one result,
 * replayed to whoever asks for it again within the TTL.
 */
type PaidRun = {
  fingerprint: string;
  expiresAt: number;
  run: Promise<SerializedResponse>;
};

const paidRunCache = new Map<string, PaidRun>();

function toResponse(captured: SerializedResponse): Response {
  return new Response(captured.body, {
    status: captured.status,
    headers: captured.headers,
  });
}

async function captureResponse(response: Response): Promise<SerializedResponse> {
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  };
}

/** The in-flight or completed paid run for this authorization, if any. */
function existingPaidRun(key: string, fingerprint: string): Promise<SerializedResponse> | null {
  const cached = paidRunCache.get(key);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  if (cached.expiresAt <= Date.now()) {
    paidRunCache.delete(key);
    return null;
  }
  return cached.run;
}

export type X402GateDependencies = Readonly<{
  verifierFactory?: (cfg: AtlasConfig) => PaymentVerifier;
}>;

function paidCallsIn(messages: JsonRpcCall[]): PaidCall[] {
  const calls: PaidCall[] = [];
  for (const message of messages) {
    const tool = message?.params?.name;
    if (
      message?.method === "tools/call" &&
      typeof tool === "string" &&
      PAID_TOOLS.has(tool)
    ) {
      calls.push({ tool, message });
    }
  }
  return calls;
}

function acceptsEventStream(accept: string | null): boolean {
  const normalized = accept?.toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("text/event-stream") ||
    normalized.includes("*/*") ||
    normalized.includes("text/*")
  );
}

function handlerRequest(req: Request, bodyText: string): Request {
  const headers = new Headers(req.headers);
  headers.set("accept", ACCEPT_BOTH);
  return new Request(req.url, {
    method: req.method,
    headers,
    body: bodyText,
    redirect: req.redirect,
    signal: req.signal,
  });
}

function parseSseData(sse: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore SSE comments, keepalives, and non-JSON events.
    }
  }
  return messages;
}

async function finalize(
  response: Response,
  clientWantsEventStream: boolean,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const isSse = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");

  if (clientWantsEventStream || !isSse) {
    if (!extraHeaders) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const messages = parseSseData(await response.text());
  const payload = messages.length === 1 ? messages[0] : messages;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
  }
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcError(
  code: number,
  message: string,
  data?: Record<string, unknown>,
  status = 400,
  extraHeaders?: Record<string, string>,
  id: unknown = null
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...extraHeaders,
      },
    }
  );
}

function cleanupSettlementCache(now: number): void {
  for (const [key, entry] of settlementCache) {
    if (entry.expiresAt <= now) settlementCache.delete(key);
  }
  for (const [key, entry] of paidRunCache) {
    if (entry.expiresAt <= now) paidRunCache.delete(key);
  }
}

function settlementKey(
  cfg: AtlasConfig,
  payer: string,
  nonce: string
): string {
  return [cfg.network, cfg.asset, payer, nonce]
    .map((part) => part.toLowerCase())
    .join(":");
}

function paymentFingerprint(payment: PaymentPayload): string {
  return JSON.stringify({
    accepted: payment.accepted,
    payload: payment.payload,
  });
}

function paymentResponseHeader(
  status: "settled" | "verified" | "pending",
  amount: bigint,
  payer: string,
  transaction?: string
): string {
  return encodePaymentResponseHeader({
    status,
    transaction,
    amount: amount.toString(),
    payer,
  });
}

function pendingResponse(
  id: unknown,
  amount: bigint,
  payer: string,
  message: string,
  transaction?: string
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        status: "pending",
        message,
        ...(transaction ? { transaction } : {}),
      },
    }),
    {
      status: 202,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "3",
        "payment-response": paymentResponseHeader(
          "pending",
          amount,
          payer,
          transaction
        ),
      },
    }
  );
}

function settlementStateResponse(
  result: SettleResult,
  id: unknown,
  amount: bigint
): Response {
  if (result.status === "pending") {
    return pendingResponse(
      id,
      amount,
      result.payer,
      result.errorReason ?? "Settlement confirmation is pending.",
      result.transaction
    );
  }
  if (result.status === "ambiguous") {
    return jsonRpcError(
      -32002,
      "Payment settlement status is ambiguous; paid work has not started.",
      {
        status: "pending",
        reason: result.errorReason,
        ...(result.transaction ? { transaction: result.transaction } : {}),
      },
      503,
      {
        "retry-after": "5",
        "payment-response": paymentResponseHeader(
          "pending",
          amount,
          result.payer,
          result.transaction
        ),
      },
      id
    );
  }
  if (result.status === "failed") {
    return jsonRpcError(
      -32003,
      "Payment settlement service failed; paid work has not started.",
      {
        status: "failed",
        reason: result.errorReason,
        ...(result.transaction ? { transaction: result.transaction } : {}),
      },
      502,
      undefined,
      id
    );
  }

  return jsonRpcError(
    -32004,
    "This payment authorization has already been settled and consumed.",
    {
      status: "settled",
      ...(result.transaction ? { transaction: result.transaction } : {}),
    },
    409,
    {
      "payment-response": paymentResponseHeader(
        result.transaction ? "settled" : "verified",
        amount,
        result.payer,
        result.transaction
      ),
    },
    id
  );
}

/**
 * Wrap an Atlas MCP HTTP handler with x402 v2 exact payment enforcement.
 * Settlement is completed before the wrapped handler starts paid work.
 */
export function withX402Gate(
  handler: (req: Request) => Promise<Response>,
  dependencies: X402GateDependencies = {}
): (req: Request) => Promise<Response> {
  const verifierFactory = dependencies.verifierFactory ?? getVerifier;

  return async (req: Request): Promise<Response> => {
    const cfg = getAtlasConfig();

    if (req.method !== "POST") {
      const response = await handler(req);
      if (
        cfg &&
        req.method === "GET" &&
        (response.status === 405 || response.status === 406)
      ) {
        return build402Response(cfg, cfg.publicBaseUrl);
      }
      return response;
    }

    const bodyText = await req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // A marketplace reachability probe POSTs an empty or non-JSON-RPC body and
      // expects 402 or 200 — it reads anything else, 400 included, as an
      // unreachable endpoint. Answer an unauthenticated probe with the payment
      // challenge instead. A caller that did send a payment header still gets a
      // parse error, because charging for an unreadable request would be wrong.
      if (cfg && !req.headers.get("payment-signature")) {
        return build402Response(cfg, cfg.publicBaseUrl);
      }
      return jsonRpcError(
        -32700,
        "Parse error: request body is not valid JSON."
      );
    }

    const messages: JsonRpcCall[] = Array.isArray(parsed)
      ? (parsed as JsonRpcCall[])
      : parsed && typeof parsed === "object"
        ? [parsed as JsonRpcCall]
        : [];
    const paidCalls = paidCallsIn(messages);

    if (Array.isArray(parsed) && paidCalls.length > 1) {
      return jsonRpcError(
        -32600,
        "x402 JSON-RPC batches may contain at most one paid tool call; split paid calls into separate requests.",
        {
          paidToolCount: paidCalls.length,
          paidTools: paidCalls.map(({ tool }) => tool),
        }
      );
    }

    const clientWantsEventStream = acceptsEventStream(req.headers.get("accept"));
    if (!cfg || paidCalls.length === 0) {
      const response = await handler(handlerRequest(req, bodyText));
      return finalize(response, clientWantsEventStream);
    }

    // Never derive this value from req.url, Host, Forwarded, or X-Forwarded-*.
    const resourceUrl = cfg.publicBaseUrl;
    const paidCall = paidCalls[0]!;
    const tool = paidCall.tool;
    const amount = priceForTool(tool);
    if (amount === undefined) {
      return jsonRpcError(-32602, `No x402 price configured for paid tool ${tool}.`);
    }

    const rawPaymentHeader = req.headers.get("payment-signature");
    if (!rawPaymentHeader) {
      return build402Response(cfg, resourceUrl, undefined, amount);
    }
    const payment = decodePaymentHeader(req);
    if (!payment) {
      return build402Response(
        cfg,
        resourceUrl,
        "Invalid PAYMENT-SIGNATURE: expected a base64-encoded x402 v2 exact envelope.",
        amount
      );
    }

    const requirements = buildAccepts(cfg, amount)[0]!;
    const verifier = verifierFactory(cfg);
    const id = paidCall.message.id ?? null;
    const fingerprint = paymentFingerprint(payment);
    const claimedKey = settlementKey(
      cfg,
      payment.payload.authorization.from,
      payment.payload.authorization.nonce
    );
    const now = Date.now();
    cleanupSettlementCache(now);

    const runPaidHandler = async (
      key: string,
      expiresAt: number,
      settlement: Extract<SettleResult, { status: "settled" }>
    ): Promise<Response> => {
      const alreadyRunning = existingPaidRun(key, fingerprint);
      if (alreadyRunning) return toResponse(await alreadyRunning);

      const run = (async () => {
        const response = await handler(handlerRequest(req, bodyText));
        const finalized = await finalize(response, clientWantsEventStream, {
          "payment-response": paymentResponseHeader(
            settlement.transaction ? "settled" : "verified",
            amount,
            settlement.payer,
            settlement.transaction
          ),
        });
        return captureResponse(finalized);
      })();

      if (paidRunCache.size < SETTLEMENT_CACHE_MAX_ENTRIES) {
        paidRunCache.set(key, { fingerprint, expiresAt, run });
        // A failed run must not be replayed to later callers as the outcome.
        run.catch(() => paidRunCache.delete(key));
      }
      return toResponse(await run);
    };

    const respondToMatchingCache = async (
      key: string,
      cached: CachedSettlement
    ): Promise<Response | null> => {
      if (cached.fingerprint !== fingerprint) return null;

      // A duplicate of a paid call that already ran — or is running right now —
      // gets that same answer back rather than a "pending" with no result.
      const alreadyRunning = existingPaidRun(key, fingerprint);
      if (alreadyRunning) return toResponse(await alreadyRunning);

      if (cached.kind === "settling") {
        // Wait for the settlement this authorization already started rather than
        // answering "pending" and leaving the caller with no result. Only a
        // caller that waits past the deadline is told to retry.
        const timedOut = Symbol("timeout");
        const outcome = await Promise.race([
          cached.settlement.catch(() => timedOut),
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => resolve(timedOut), DUPLICATE_WAIT_MS)
          ),
        ]);
        if (outcome === timedOut) {
          return pendingResponse(
            id,
            amount,
            cached.payer,
            "Settlement is already in progress for this authorization."
          );
        }
        const settled = outcome as SettleResult;
        return settled.status === "settled"
          ? runPaidHandler(key, cached.expiresAt, settled)
          : settlementStateResponse(settled, id, amount);
      }
      if (cached.kind === "checking") {
        return settlementStateResponse(cached.result, id, amount);
      }

      const prior = cached.result;
      if (prior.status !== "pending" || !verifier.checkSettlement) {
        return settlementStateResponse(prior, id, amount);
      }

      settlementCache.set(key, {
        kind: "checking",
        result: prior,
        fingerprint,
        expiresAt: cached.expiresAt,
      });
      let updated: SettleResult = prior;
      try {
        updated = await verifier.checkSettlement(
          payment,
          requirements,
          prior
        );
      } catch {
        // A status lookup must never trigger a second settlement or erase the
        // known broadcast hash. Keep the transaction pending and retry later.
      }
      settlementCache.set(key, {
        kind: "result",
        result: updated,
        fingerprint,
        expiresAt: cached.expiresAt,
      });
      return updated.status === "settled"
        ? runPaidHandler(key, cached.expiresAt, updated)
        : settlementStateResponse(updated, id, amount);
    };

    const cachedBeforeVerification = settlementCache.get(claimedKey);
    if (cachedBeforeVerification) {
      const cachedResponse = await respondToMatchingCache(
        claimedKey,
        cachedBeforeVerification
      );
      if (cachedResponse) return cachedResponse;
    }

    const verdict = await verifier.verify(payment, requirements);
    if (!verdict.valid) {
      return build402Response(
        cfg,
        resourceUrl,
        `Invalid payment: ${verdict.reason}.`,
        amount
      );
    }

    const key = settlementKey(
      cfg,
      verdict.payer,
      payment.payload.authorization.nonce
    );
    const cached = settlementCache.get(key);
    if (cached) {
      const cachedResponse = await respondToMatchingCache(key, cached);
      if (cachedResponse) return cachedResponse;
      if (cached.kind === "settling") {
        return pendingResponse(
          id,
          amount,
          cached.payer,
          "Settlement is already in progress for this authorization."
        );
      }
      return settlementStateResponse(cached.result, id, amount);
    }
    if (settlementCache.size >= SETTLEMENT_CACHE_MAX_ENTRIES) {
      return jsonRpcError(
        -32005,
        "Payment settlement is temporarily unavailable; retry shortly with the same authorization.",
        { status: "unavailable" },
        503,
        { "retry-after": "5" },
        id
      );
    }

    const expiresAt = now + SETTLEMENT_CACHE_TTL_MS;

    // Publish the in-flight settlement before awaiting it, so a duplicate that
    // arrives mid-flight attaches to this exact promise instead of starting a
    // second settlement or being turned away with "pending".
    const settlementPromise = verifier.settle(payment, requirements).catch(
      (): SettleResult => ({
        status: "ambiguous",
        success: false,
        payer: verdict.payer,
        errorReason: "settlement call ended without a definitive response",
      })
    );
    settlementCache.set(key, {
      kind: "settling",
      payer: verdict.payer,
      fingerprint,
      expiresAt,
      settlement: settlementPromise,
    });

    const settlement = await settlementPromise;
    settlementCache.set(key, {
      kind: "result",
      result: settlement,
      fingerprint,
      expiresAt,
    });

    return settlement.status === "settled"
      ? runPaidHandler(key, expiresAt, settlement)
      : settlementStateResponse(settlement, id, amount);
  };
}
