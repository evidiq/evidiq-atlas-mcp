import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AtlasConfig } from "./config.js";
import type { PaymentVerifier } from "./facilitator.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "./types.js";
import { verifyPaymentLocal } from "./verify.js";

const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const RECEIPT_ATTEMPTS = 40;
const RECEIPT_POLL_MS = 1_500;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Submit and confirm an EIP-3009 transferWithAuthorization via viem. */
export class OnchainSettler implements PaymentVerifier {
  constructor(private readonly cfg: AtlasConfig) {}

  verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult> {
    return verifyPaymentLocal(payment, requirements, this.cfg);
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult> {
    const payer = payment.payload.authorization.from;
    const verdict = await verifyPaymentLocal(payment, requirements, this.cfg);
    if (!verdict.valid) {
      return {
        status: "failed",
        success: false,
        payer,
        errorReason: verdict.reason,
      };
    }
    if (BigInt(requirements.amount) === 0n) {
      return { status: "settled", success: true, transaction: "", payer };
    }
    if (!this.cfg.settleKey) {
      return {
        status: "failed",
        success: false,
        payer,
        errorReason:
          "on-chain settlement requires X402_SETTLE_KEY (a gas-funded X Layer wallet)",
      };
    }

    const authorization = payment.payload.authorization;
    let broadcastHash: string | undefined;

    try {
      const chain = defineChain({
        id: this.cfg.chainId,
        name: "X Layer",
        nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
        rpcUrls: { default: { http: [this.cfg.rpcUrl] } },
      });
      const account = privateKeyToAccount(this.cfg.settleKey);
      const transport = http(this.cfg.rpcUrl);
      const wallet = createWalletClient({ account, chain, transport });
      const publicClient = createPublicClient({ chain, transport });

      let gasPrice: bigint;
      try {
        gasPrice = ((await publicClient.getGasPrice()) * 12n) / 10n;
      } catch {
        gasPrice = 1_000_000_000n;
      }

      const hash = await wallet.writeContract({
        address: this.cfg.asset,
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          authorization.from,
          authorization.to,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce,
          payment.payload.signature,
        ],
        gas: 300_000n,
        gasPrice,
      });
      broadcastHash = hash;

      let receiptStatus: "success" | "reverted" | undefined;
      for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash });
          receiptStatus = receipt.status;
          break;
        } catch {
          if (attempt + 1 < RECEIPT_ATTEMPTS) {
            await delay(RECEIPT_POLL_MS);
          }
        }
      }

      if (receiptStatus === "reverted") {
        return {
          status: "failed",
          success: false,
          transaction: hash,
          payer,
          errorReason: "settlement transaction reverted",
        };
      }
      if (receiptStatus !== "success") {
        return {
          status: "pending",
          success: false,
          transaction: hash,
          payer,
          errorReason: "settlement transaction broadcast; confirmation pending",
        };
      }
      return { status: "settled", success: true, transaction: hash, payer };
    } catch (error) {
      if (broadcastHash) {
        return {
          status: "pending",
          success: false,
          transaction: broadcastHash,
          payer,
          errorReason: "settlement transaction broadcast; confirmation pending",
        };
      }
      return {
        status: "failed",
        success: false,
        payer,
        errorReason: `settlement failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async checkSettlement(
    _payment: PaymentPayload,
    _requirements: PaymentRequirements,
    settlement: Extract<SettleResult, { status: "pending" }>
  ): Promise<SettleResult> {
    const chain = defineChain({
      id: this.cfg.chainId,
      name: "X Layer",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [this.cfg.rpcUrl] } },
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(this.cfg.rpcUrl),
    });

    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: settlement.transaction as `0x${string}`,
      });
      if (receipt.status === "success") {
        return {
          status: "settled",
          success: true,
          transaction: settlement.transaction,
          payer: settlement.payer,
        };
      }
      return {
        status: "failed",
        success: false,
        transaction: settlement.transaction,
        payer: settlement.payer,
        errorReason: "settlement transaction reverted",
      };
    } catch {
      return settlement;
    }
  }
}
