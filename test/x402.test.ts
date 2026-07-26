import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildAccepts,
  buildDiscoveryResponse,
} from "../lib/x402/challenge.js";
import { getAtlasConfig, TOOL_PRICES } from "../lib/x402/config.js";
import {
  FacilitatorClient,
  type PaymentVerifier,
} from "../lib/x402/facilitator.js";
import { withX402Gate } from "../lib/x402/gate.js";
import type {
  Eip3009Authorization,
  Hex,
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
} from "../lib/x402/types.js";
import {
  decodePaymentHeader,
  verifyPaymentLocal,
} from "../lib/x402/verify.js";

const envNames = [
  "NODE_ENV",
  "X402_PAY_TO",
  "X402_NETWORK",
  "X402_CHAIN",
  "X402_ASSET",
  "PUBLIC_BASE_URL",
  "X402_SETTLE_KEY",
  "X402_USE_FACILITATOR",
  "X402_FACILITATOR_URL",
  "X402_RPC",
  "X402_RPC_URL",
  "OKX_API_KEY",
  "OKX_SECRET_KEY",
  "OKX_PASSPHRASE",
] as const;
const original = new Map(envNames.map((name) => [name, process.env[name]]));

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const payerAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
let nonceCounter = 0n;

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "eip155:196";
  process.env.X402_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
  process.env.PUBLIC_BASE_URL = "https://mcp.example.test/atlas";
  delete process.env.X402_CHAIN;
  delete process.env.X402_SETTLE_KEY;
  delete process.env.X402_USE_FACILITATOR;
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.X402_RPC;
  delete process.env.X402_RPC_URL;
  // Keep the local verifier path deterministic: an ambient OKX credential must
  // not switch these tests onto the official SDK (which would call the network).
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_SECRET_KEY;
  delete process.env.OKX_PASSPHRASE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of envNames) {
    const value = original.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Atlas x402 configuration", () => {
  it("runs ungated (null) when X402_PAY_TO is unset", () => {
    delete process.env.X402_PAY_TO;

    expect(getAtlasConfig()).toBeNull();
  });

  it("resolves the X402_CHAIN slug to a CAIP-2 network", () => {
    delete process.env.X402_NETWORK;
    process.env.X402_CHAIN = "x-layer";

    expect(getAtlasConfig()).toMatchObject({
      network: "eip155:196",
      chainId: 196,
    });
  });

  it("returns the configured payee, asset, and X Layer defaults", () => {
    delete process.env.X402_FACILITATOR_URL;
    delete process.env.X402_RPC;

    expect(getAtlasConfig()).toMatchObject({
      network: "eip155:196",
      chainId: 196,
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      payTo: "0x1111111111111111111111111111111111111111",
      facilitatorUrl: "https://web3.okx.com",
      rpcUrl: "https://rpc.xlayer.tech",
      useFacilitator: false,
    });
  });

  it("rejects a malformed settlement key without exposing it", () => {
    const key = "0xdefinitely-not-a-valid-private-key";
    process.env.X402_SETTLE_KEY = key;
    let message = "";

    try {
      getAtlasConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/X402_SETTLE_KEY/);
    expect(message).not.toContain(key);
  });

  it("accepts a valid settlement key", () => {
    process.env.X402_SETTLE_KEY = TEST_PRIVATE_KEY;

    expect(getAtlasConfig()?.settleKey).toBe(TEST_PRIVATE_KEY);
  });

  it("enables the facilitator verifier when X402_USE_FACILITATOR=1", () => {
    process.env.X402_USE_FACILITATOR = "1";

    expect(getAtlasConfig()?.useFacilitator).toBe(true);
  });
});

function rpc(name: string, id: number | string = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} },
  };
}

function request(body: unknown, paymentSignature?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
  });
  if (paymentSignature) headers.set("payment-signature", paymentSignature);
  return new Request("http://attacker.invalid/forwarded/path", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function nextNonce(): Hex {
  nonceCounter += 1n;
  return `0x${nonceCounter.toString(16).padStart(64, "0")}` as Hex;
}

function encodePayment(payment: PaymentPayload): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: payment.x402Version,
      accepted: payment.accepted,
      payload: payment.payload,
    }),
    "utf8"
  ).toString("base64");
}

async function signedPayment(
  overrides: Partial<Eip3009Authorization> = {},
  requirementsOverride?: PaymentRequirements
): Promise<{
  payment: PaymentPayload;
  requirements: PaymentRequirements;
  header: string;
}> {
  const cfg = getAtlasConfig();
  if (!cfg) throw new Error("test x402 config unavailable");
  const requirements =
    requirementsOverride ?? buildAccepts(cfg, TOOL_PRICES.profile_dataset)[0]!;
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const authorization: Eip3009Authorization = {
    from: payerAccount.address,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: (now - 5n).toString(),
    validBefore: (now + 120n).toString(),
    nonce: nextNonce(),
    ...overrides,
  };
  const signature = await payerAccount.signTypedData({
    domain: {
      name: cfg.domainName,
      version: cfg.domainVersion,
      chainId: cfg.chainId,
      verifyingContract: cfg.asset,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const payment: PaymentPayload = {
    x402Version: 2,
    accepted: {
      ...requirements,
      extra: { ...requirements.extra },
    },
    scheme: requirements.scheme,
    network: requirements.network,
    payload: { signature, authorization },
  };
  return { payment, requirements, header: encodePayment(payment) };
}

function decodePaymentResponse(response: Response): Record<string, unknown> {
  const header = response.headers.get("payment-response");
  if (!header) throw new Error("PAYMENT-RESPONSE missing");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("Atlas x402 payment verification", () => {
  it("accepts a signed EIP-3009 authorization for the exact amount", async () => {
    const cfg = getAtlasConfig()!;
    const signed = await signedPayment();
    const decoded = decodePaymentHeader(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(decoded).not.toBeNull();
    await expect(
      verifyPaymentLocal(decoded!, signed.requirements, cfg)
    ).resolves.toEqual({ valid: true, payer: payerAccount.address });
  });

  it("rejects a correctly signed overpayment", async () => {
    const cfg = getAtlasConfig()!;
    const requirements = buildAccepts(cfg, TOOL_PRICES.profile_dataset)[0]!;
    const signed = await signedPayment({
      value: (BigInt(requirements.amount) + 1n).toString(),
    });
    const verdict = await verifyPaymentLocal(
      signed.payment,
      signed.requirements,
      cfg
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toContain("exactly match");
  });

  it.each([
    "scheme",
    "network",
    "asset",
    "amount",
    "payTo",
    "maxTimeoutSeconds",
    "extra",
  ])("rejects decoding when accepted.%s is omitted", async (field) => {
    const signed = await signedPayment();
    const accepted = {
      ...signed.payment.accepted,
      extra: { ...signed.payment.accepted.extra },
    } as Record<string, unknown>;
    delete accepted[field];
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted,
        payload: signed.payment.payload,
      }),
      "utf8"
    ).toString("base64");
    expect(
      decodePaymentHeader(request(rpc("profile_dataset"), header))
    ).toBeNull();
  });

  it.each([
    ["future", 30n, 120n, "not yet valid"],
    ["expired", -120n, -30n, "expired"],
    ["overlong", -5n, 330n, "maxTimeoutSeconds"],
    ["overlong lifetime", -600n, 120n, "lifetime"],
  ])(
    "rejects a %s EIP-3009 validity window",
    async (_case, validAfterOffset, validBeforeOffset, reason) => {
      const cfg = getAtlasConfig()!;
      const now = BigInt(Math.floor(Date.now() / 1_000));
      const signed = await signedPayment({
        validAfter: (now + validAfterOffset).toString(),
        validBefore: (now + validBeforeOffset).toString(),
      });
      const verdict = await verifyPaymentLocal(
        signed.payment,
        signed.requirements,
        cfg
      );
      expect(verdict.valid).toBe(false);
      if (!verdict.valid) expect(verdict.reason).toContain(reason);
    }
  );

  it("treats a non-definitive facilitator HTTP 202 as ambiguous", async () => {
    process.env.X402_USE_FACILITATOR = "1";
    const cfg = getAtlasConfig()!;
    const signed = await signedPayment();
    const transaction = `0x${"cd".repeat(32)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, transaction }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const settlement = await new FacilitatorClient(cfg).settle(
      signed.payment,
      signed.requirements
    );
    expect(settlement.status).toBe("ambiguous");
  });
});

describe("Atlas x402 gate", () => {
  it("passes free tools without payment", async () => {
    let calls = 0;
    const gate = withX402Gate(async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const response = await gate(request(rpc("atlas_capabilities")));
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it.each([
    ["profile_dataset", "5000"],
    ["query_dataset", "10000"],
    ["visualize_dataset", "15000"],
    ["compare_datasets", "20000"],
    ["research_dataset", "30000"],
  ])("challenges %s at its exact immutable price", async (tool, amount) => {
    const gate = withX402Gate(async () => new Response("should not run"));
    const response = await gate(request(rpc(tool)));
    const body = (await response.json()) as {
      resource: { url: string };
      accepts: Array<{ amount: string }>;
    };
    expect(response.status).toBe(402);
    expect(body.accepts[0]?.amount).toBe(amount);
    expect(body.resource.url).toBe("https://mcp.example.test/atlas/mcp");
  });

  it("rejects a JSON-RPC batch with multiple paid calls before work", async () => {
    let calls = 0;
    const gate = withX402Gate(async () => {
      calls += 1;
      return new Response("unexpected");
    });
    const response = await gate(
      request([rpc("profile_dataset", 1), rpc("query_dataset", 2)])
    );
    const body = (await response.json()) as {
      error: { code: number; data: { paidToolCount: number } };
    };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32600);
    expect(body.error.data.paidToolCount).toBe(2);
    expect(calls).toBe(0);
  });

  it("discovery exposes all five paid and five free tools", async () => {
    const config = getAtlasConfig();
    expect(config).not.toBeNull();
    const response = buildDiscoveryResponse(config!);
    const body = (await response.json()) as {
      pricing: Array<{ tool: string; amount: string }>;
    };
    expect(body.pricing).toHaveLength(10);
    expect(
      body.pricing.find((item) => item.tool === "research_dataset")?.amount
    ).toBe(TOOL_PRICES.research_dataset.toString());
  });

  it("disables payment but preserves JSON/SSE transport normalization when X402_PAY_TO is absent", async () => {
    delete process.env.X402_PAY_TO;
    let calls = 0;
    const gate = withX402Gate(async (normalizedRequest) => {
      calls += 1;
      expect(normalizedRequest.headers.get("accept")).toContain(
        "text/event-stream"
      );
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    const response = await gate(request(rpc("research_dataset")));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      result: { ok: true },
    });
    expect(calls).toBe(1);
  });

  it("returns and caches HTTP 202 for a broadcast settlement pending receipt", async () => {
    const cfg = getAtlasConfig()!;
    const signed = await signedPayment();
    const transaction = `0x${"ab".repeat(32)}`;
    let handlerCalls = 0;
    let verifyCalls = 0;
    let settleCalls = 0;
    const verifier: PaymentVerifier = {
      verify: (payment, requirements) => {
        verifyCalls += 1;
        return verifyPaymentLocal(payment, requirements, cfg);
      },
      settle: async (payment): Promise<SettleResult> => {
        settleCalls += 1;
        return {
          status: "pending",
          success: false,
          transaction,
          payer: payment.payload.authorization.from,
        };
      },
    };
    const gate = withX402Gate(
      async () => {
        handlerCalls += 1;
        return new Response("unexpected");
      },
      { verifierFactory: () => verifier }
    );

    const first = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(first.status).toBe(202);
    expect(first.headers.get("payment-required")).toBeNull();
    expect(decodePaymentResponse(first)).toMatchObject({
      status: "pending",
      transaction,
    });

    const retry = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(retry.status).toBe(202);
    expect(verifyCalls).toBe(1);
    expect(settleCalls).toBe(1);
    expect(handlerCalls).toBe(0);
  });

  it("checks a pending receipt without resettling and runs paid work once", async () => {
    const cfg = getAtlasConfig()!;
    const signed = await signedPayment();
    const transaction = `0x${"ef".repeat(32)}`;
    let handlerCalls = 0;
    let settleCalls = 0;
    let statusCalls = 0;
    const verifier: PaymentVerifier = {
      verify: (payment, requirements) =>
        verifyPaymentLocal(payment, requirements, cfg),
      settle: async (payment): Promise<SettleResult> => {
        settleCalls += 1;
        return {
          status: "pending",
          success: false,
          transaction,
          payer: payment.payload.authorization.from,
        };
      },
      checkSettlement: async (_payment, _requirements, pending) => {
        statusCalls += 1;
        return {
          status: "settled",
          success: true,
          transaction: pending.transaction,
          payer: pending.payer,
        };
      },
    };
    const gate = withX402Gate(
      async () => {
        handlerCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
      { verifierFactory: () => verifier }
    );

    const first = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(first.status).toBe(202);

    const confirmed = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(confirmed.status).toBe(200);
    expect(decodePaymentResponse(confirmed)).toMatchObject({
      status: "settled",
      transaction,
    });
    expect(settleCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(handlerCalls).toBe(1);

    // A repeat of an already-completed paid call is idempotent: the caller gets
    // the same result back, while settlement and the paid work still happen
    // exactly once. Answering an error here would make a client that retries
    // (or sends the request twice) believe its paid call failed.
    const replay = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(replay.status).toBe(200);
    expect(decodePaymentResponse(replay)).toMatchObject({
      status: "settled",
      transaction,
    });
    expect(settleCalls).toBe(1);
    expect(handlerCalls).toBe(1);
  });

  it("lets a concurrent duplicate authorization wait and receive the same result", async () => {
    const signed = await signedPayment();
    let handlerCalls = 0;
    let settleCalls = 0;
    const transaction = `0x${"cc".repeat(32)}`;
    const verifier: PaymentVerifier = {
      verify: async () => ({ valid: true, payer: payerAccount.address }),
      settle: async () => {
        settleCalls += 1;
        // Hold the settlement open so the second request genuinely overlaps.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          status: "settled",
          success: true,
          transaction,
          payer: payerAccount.address,
        };
      },
    };
    const gate = withX402Gate(
      async () => {
        handlerCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
      { verifierFactory: () => verifier }
    );

    const [first, duplicate] = await Promise.all([
      gate(request(rpc("profile_dataset"), signed.header)),
      gate(request(rpc("profile_dataset"), signed.header)),
    ]);

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(decodePaymentResponse(duplicate)).toMatchObject({
      status: "settled",
      transaction,
    });
    expect(settleCalls).toBe(1);
    expect(handlerCalls).toBe(1);
  });

  it("returns and caches a 5xx response for ambiguous facilitator settlement", async () => {
    const cfg = getAtlasConfig()!;
    const signed = await signedPayment();
    let handlerCalls = 0;
    let settleCalls = 0;
    const verifier: PaymentVerifier = {
      verify: (payment, requirements) =>
        verifyPaymentLocal(payment, requirements, cfg),
      settle: async (payment): Promise<SettleResult> => {
        settleCalls += 1;
        return {
          status: "ambiguous",
          success: false,
          payer: payment.payload.authorization.from,
          errorReason: "facilitator timed out",
        };
      },
    };
    const gate = withX402Gate(
      async () => {
        handlerCalls += 1;
        return new Response("unexpected");
      },
      { verifierFactory: () => verifier }
    );

    const first = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(first.status).toBeLessThan(600);
    expect(first.headers.get("payment-required")).toBeNull();
    expect(decodePaymentResponse(first)).toMatchObject({ status: "pending" });

    const retry = await gate(
      request(rpc("profile_dataset"), signed.header)
    );
    expect(retry.status).toBeGreaterThanOrEqual(500);
    expect(retry.status).toBeLessThan(600);
    expect(retry.headers.get("payment-required")).toBeNull();
    expect(settleCalls).toBe(1);
    expect(handlerCalls).toBe(0);
  });
});
