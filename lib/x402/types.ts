/** x402 v2 protocol types used by EVIDIQ Atlas. */

export type Hex = `0x${string}`;

export type X402Resource = {
  url: string;
  description: string;
  mimeType: string;
};

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: Hex;
  amount: string;
  payTo: Hex;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
  };
};

export type Eip3009Authorization = {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export type AcceptedPaymentRequirements = PaymentRequirements;

/**
 * Decoded PAYMENT-SIGNATURE value. The wire envelope contains a complete
 * `accepted` challenge; scheme and network are also normalized for external
 * verifier compatibility.
 */
export type PaymentPayload = {
  x402Version: 2;
  accepted: AcceptedPaymentRequirements;
  scheme: "exact";
  network: string;
  payload: {
    signature: Hex;
    authorization: Eip3009Authorization;
  };
};

export type X402Challenge = {
  x402Version: 2;
  resource: X402Resource;
  accepts: PaymentRequirements[];
};

export type VerifyResult =
  | { valid: true; payer: Hex }
  | { valid: false; reason: string };

export type SettleResult =
  | {
      status: "settled";
      success: true;
      transaction?: string;
      payer: string;
    }
  | {
      status: "pending";
      success: false;
      transaction: string;
      payer: string;
      errorReason?: string;
    }
  | {
      status: "ambiguous" | "failed";
      success: false;
      transaction?: string;
      payer: string;
      errorReason: string;
    };

export type SettlementResult = SettleResult;

export type PaymentResponseHeader = {
  status: "settled" | "verified" | "pending";
  transaction?: string;
  amount: string;
  payer: string;
};
