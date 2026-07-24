import { createHash } from "node:crypto";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const ATLAS_REPORT_SCHEMA_VERSION = "evidiq.atlas.report.v1" as const;
export const ATLAS_REPORT_SERVICE = "EVIDIQ Atlas" as const;
export const ATLAS_REPORT_SERVICE_VERSION = "0.1.0" as const;
export const ATLAS_REPORT_DIGEST_ALGORITHM = "sha256" as const;
export const ATLAS_REPORT_CANONICALIZATION = "evidiq-jcs-v1" as const;

function normalize(value: unknown, inArray = false, stack = new WeakSet<object>()): JsonValue | undefined {
  if (value === undefined) return inArray ? null : undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new Error("Canonical JSON cannot contain circular references");
    stack.add(value);
    try {
      return value.map((item) => normalize(item, true, stack) ?? null);
    } finally {
      stack.delete(value);
    }
  }
  if (typeof value === "object") {
    if (stack.has(value)) throw new Error("Canonical JSON cannot contain circular references");
    stack.add(value);
    try {
      const out = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const item = normalize((value as Record<string, unknown>)[key], false, stack);
        if (item !== undefined) out[key] = item;
      }
      return out;
    } finally {
      stack.delete(value);
    }
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalStringify(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === undefined) throw new Error("Cannot canonicalize undefined");
  return JSON.stringify(normalized);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export type AtlasDatasetReference = Readonly<{
  name: string;
  format: string;
  digest: string;
  bytes: number;
  sourceKind: "inline" | "url";
  sourceUrl?: string;
  sourceQueryRedacted?: boolean;
}>;

export type AtlasReportBody = Readonly<{
  schemaVersion: typeof ATLAS_REPORT_SCHEMA_VERSION;
  service: typeof ATLAS_REPORT_SERVICE;
  serviceVersion: typeof ATLAS_REPORT_SERVICE_VERSION;
  tool: string;
  engine: Readonly<{ name: "DuckDB"; version: string }>;
  datasets: readonly AtlasDatasetReference[];
  request: JsonValue;
  result: JsonValue;
  methods: readonly string[];
  assumptions: readonly string[];
  warnings: readonly string[];
  reproducibility: Readonly<{
    deterministic: boolean;
    sourceDigests: readonly string[];
    sql?: string;
    rowLimit?: number;
    sandboxProvider: "local-duckdb" | "e2b";
  }>;
}>;

export type AtlasReport = Readonly<{
  reportId: string;
  body: AtlasReportBody;
  integrity: Readonly<{
    algorithm: typeof ATLAS_REPORT_DIGEST_ALGORITHM;
    canonicalization: typeof ATLAS_REPORT_CANONICALIZATION;
    digest: string;
    signature?: Hex;
    signer?: Hex;
  }>;
}>;

type UnknownRecord = Record<string, unknown>;

function dataRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${path} cannot contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}.${key} must be an enumerable data property`);
    }
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path} contains unsupported property ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${path}.${key} is missing`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${path} must be a non-negative safe integer`);
  return result;
}

function literalValue<const T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}`);
  return expected;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${path} cannot be sparse`);
    stringValue(value[index], `${path}[${index}]`);
  }
  return value as string[];
}

function assertJsonValue(value: unknown, path: string, stack = new WeakSet<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    finiteNumber(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new Error(`${path} cannot contain circular references`);
    stack.add(value);
    try {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (typeof key === "symbol") throw new Error(`${path} cannot contain symbol keys`);
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`${path} contains unsupported array property ${key}`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${path} cannot be sparse`);
        assertJsonValue(value[index], `${path}[${index}]`, stack);
      }
    } finally {
      stack.delete(value);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = dataRecord(value, path);
    if (stack.has(value)) throw new Error(`${path} cannot contain circular references`);
    stack.add(value);
    try {
      for (const [key, item] of Object.entries(record)) assertJsonValue(item, `${path}.${key}`, stack);
    } finally {
      stack.delete(value);
    }
    return;
  }
  throw new Error(`${path} is not a JSON value`);
}

function validateDataset(value: unknown, index: number): void {
  const path = `report.body.datasets[${index}]`;
  const dataset = dataRecord(value, path);
  exactKeys(dataset, ["name", "format", "digest", "bytes", "sourceKind"], ["sourceUrl", "sourceQueryRedacted"], path);
  stringValue(dataset.name, `${path}.name`);
  stringValue(dataset.format, `${path}.format`);
  stringValue(dataset.digest, `${path}.digest`);
  nonNegativeInteger(dataset.bytes, `${path}.bytes`);
  if (dataset.sourceKind !== "inline" && dataset.sourceKind !== "url") {
    throw new Error(`${path}.sourceKind must be "inline" or "url"`);
  }
  if (Object.prototype.hasOwnProperty.call(dataset, "sourceUrl")) stringValue(dataset.sourceUrl, `${path}.sourceUrl`);
  if (Object.prototype.hasOwnProperty.call(dataset, "sourceQueryRedacted") && typeof dataset.sourceQueryRedacted !== "boolean") {
    throw new Error(`${path}.sourceQueryRedacted must be a boolean`);
  }
}

function validateAtlasReportBody(value: unknown): asserts value is AtlasReportBody {
  const body = dataRecord(value, "report.body");
  exactKeys(
    body,
    ["schemaVersion", "service", "serviceVersion", "tool", "engine", "datasets", "request", "result", "methods", "assumptions", "warnings", "reproducibility"],
    [],
    "report.body",
  );
  literalValue(body.schemaVersion, ATLAS_REPORT_SCHEMA_VERSION, "report.body.schemaVersion");
  literalValue(body.service, ATLAS_REPORT_SERVICE, "report.body.service");
  literalValue(body.serviceVersion, ATLAS_REPORT_SERVICE_VERSION, "report.body.serviceVersion");
  stringValue(body.tool, "report.body.tool");

  const engine = dataRecord(body.engine, "report.body.engine");
  exactKeys(engine, ["name", "version"], [], "report.body.engine");
  literalValue(engine.name, "DuckDB", "report.body.engine.name");
  stringValue(engine.version, "report.body.engine.version");

  if (!Array.isArray(body.datasets)) throw new Error("report.body.datasets must be an array");
  for (let index = 0; index < body.datasets.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(body.datasets, index)) throw new Error("report.body.datasets cannot be sparse");
    validateDataset(body.datasets[index], index);
  }
  assertJsonValue(body.request, "report.body.request");
  assertJsonValue(body.result, "report.body.result");
  stringArray(body.methods, "report.body.methods");
  stringArray(body.assumptions, "report.body.assumptions");
  stringArray(body.warnings, "report.body.warnings");

  const reproducibility = dataRecord(body.reproducibility, "report.body.reproducibility");
  exactKeys(reproducibility, ["deterministic", "sourceDigests", "sandboxProvider"], ["sql", "rowLimit"], "report.body.reproducibility");
  if (typeof reproducibility.deterministic !== "boolean") throw new Error("report.body.reproducibility.deterministic must be a boolean");
  stringArray(reproducibility.sourceDigests, "report.body.reproducibility.sourceDigests");
  if (reproducibility.sandboxProvider !== "local-duckdb" && reproducibility.sandboxProvider !== "e2b") {
    throw new Error('report.body.reproducibility.sandboxProvider must be "local-duckdb" or "e2b"');
  }
  if (Object.prototype.hasOwnProperty.call(reproducibility, "sql")) stringValue(reproducibility.sql, "report.body.reproducibility.sql");
  if (Object.prototype.hasOwnProperty.call(reproducibility, "rowLimit")) nonNegativeInteger(reproducibility.rowLimit, "report.body.reproducibility.rowLimit");
}

function validateAtlasReportStructure(value: unknown): AtlasReport {
  const report = dataRecord(value, "report");
  exactKeys(report, ["reportId", "body", "integrity"], [], "report");
  stringValue(report.reportId, "report.reportId");
  validateAtlasReportBody(report.body);

  const integrity = dataRecord(report.integrity, "report.integrity");
  exactKeys(integrity, ["algorithm", "canonicalization", "digest"], ["signature", "signer"], "report.integrity");
  literalValue(integrity.algorithm, ATLAS_REPORT_DIGEST_ALGORITHM, "report.integrity.algorithm");
  literalValue(integrity.canonicalization, ATLAS_REPORT_CANONICALIZATION, "report.integrity.canonicalization");
  const digest = stringValue(integrity.digest, "report.integrity.digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("report.integrity.digest must be a lowercase SHA-256 digest");
  if (Object.prototype.hasOwnProperty.call(integrity, "signature")) {
    const signature = stringValue(integrity.signature, "report.integrity.signature");
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("report.integrity.signature must be a 65-byte EVM signature");
  }
  if (Object.prototype.hasOwnProperty.call(integrity, "signer")) {
    const signer = stringValue(integrity.signer, "report.integrity.signer");
    if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error("report.integrity.signer must be a 20-byte EVM address");
    getAddress(signer);
  }
  return report as unknown as AtlasReport;
}

export type AtlasSignerStatus = Readonly<{
  valid: boolean;
  configured: boolean;
  privateKeyConfigured: boolean;
  addressConfigured: boolean;
  signingEnabled: boolean;
  verificationEnabled: boolean;
  signer?: Hex;
  trustedSigner?: Hex;
  error?: string;
}>;

type SignerConfiguration = Readonly<{ status: AtlasSignerStatus; privateKey: Hex | null }>;

function inspectSignerConfiguration(): SignerConfiguration {
  const rawKey = process.env.ATLAS_SIGNER_PRIVATE_KEY?.trim() || "";
  const rawAddress = process.env.ATLAS_SIGNER_ADDRESS?.trim() || "";
  const privateKeyConfigured = rawKey.length > 0;
  const addressConfigured = rawAddress.length > 0;
  const configured = privateKeyConfigured || addressConfigured;
  let privateKey: Hex | null = null;
  let derivedAddress: Hex | undefined;
  let trustedAddress: Hex | undefined;

  try {
    if (privateKeyConfigured) {
      privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error("ATLAS_SIGNER_PRIVATE_KEY must be a 32-byte EVM private key");
      }
      derivedAddress = privateKeyToAccount(privateKey).address;
    }
    if (addressConfigured) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
        throw new Error("ATLAS_SIGNER_ADDRESS must be a 20-byte EVM address");
      }
      trustedAddress = getAddress(rawAddress) as Hex;
    } else {
      trustedAddress = derivedAddress;
    }
    if (derivedAddress && trustedAddress && derivedAddress.toLowerCase() !== trustedAddress.toLowerCase()) {
      throw new Error("ATLAS_SIGNER_ADDRESS does not match ATLAS_SIGNER_PRIVATE_KEY");
    }
    return {
      privateKey,
      status: {
        valid: true,
        configured,
        privateKeyConfigured,
        addressConfigured,
        signingEnabled: privateKey !== null,
        verificationEnabled: trustedAddress !== undefined,
        signer: derivedAddress,
        trustedSigner: trustedAddress,
      },
    };
  } catch (error) {
    return {
      privateKey: null,
      status: {
        valid: false,
        configured,
        privateKeyConfigured,
        addressConfigured,
        signingEnabled: false,
        verificationEnabled: false,
        signer: derivedAddress,
        trustedSigner: trustedAddress,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Returns non-secret signer configuration information suitable for health/startup status. */
export function getAtlasSignerStatus(): AtlasSignerStatus {
  return inspectSignerConfiguration().status;
}

/** Validates signer environment configuration, throwing on malformed or mismatched values. */
export function validateAtlasSignerConfiguration(): AtlasSignerStatus {
  const status = getAtlasSignerStatus();
  if (!status.valid) throw new Error(status.error || "Invalid Atlas signer configuration");
  return status;
}

/** Short alias retained for callers that prefer configuration-style helper naming. */
export const validateAtlasSignerConfig = validateAtlasSignerConfiguration;

/** Returns the configured trusted signer (explicit address or one derived from the private key). */
export function getAtlasTrustedSignerAddress(): Hex | null {
  const status = validateAtlasSignerConfiguration();
  return status.trustedSigner ?? null;
}

function signingMessage(digest: string): string {
  return ["EVIDIQ Atlas Report v1", `sha256:${digest}`].join("\n");
}

export async function createAtlasReport(bodyInput: Omit<AtlasReportBody, "schemaVersion" | "service" | "serviceVersion">): Promise<AtlasReport> {
  const rawBody = {
    ...bodyInput,
    schemaVersion: ATLAS_REPORT_SCHEMA_VERSION,
    service: ATLAS_REPORT_SERVICE,
    serviceVersion: ATLAS_REPORT_SERVICE_VERSION,
  };
  const body = JSON.parse(canonicalStringify(rawBody)) as unknown;
  validateAtlasReportBody(body);

  const digestHex = sha256(canonicalStringify(body));
  const digest = `sha256:${digestHex}`;
  const configuration = inspectSignerConfiguration();
  if (!configuration.status.valid) throw new Error(configuration.status.error || "Invalid Atlas signer configuration");

  let signature: Hex | undefined;
  let signer: Hex | undefined;
  if (configuration.privateKey) {
    const account = privateKeyToAccount(configuration.privateKey);
    signature = await account.signMessage({ message: signingMessage(digestHex) });
    signer = account.address;
  }

  return {
    reportId: `atlas_report_${digestHex}`,
    body,
    integrity: {
      algorithm: ATLAS_REPORT_DIGEST_ALGORITHM,
      canonicalization: ATLAS_REPORT_CANONICALIZATION,
      digest,
      ...(signature && signer ? { signature, signer } : {}),
    },
  };
}

export type AtlasReportVerificationOptions = Readonly<{
  expectedSigner?: string;
}>;

export type ReportVerification = Readonly<{
  valid: boolean;
  integrityValid: boolean;
  authentic: boolean;
  authenticityValid: boolean;
  structureValid: boolean;
  digestValid: boolean;
  reportIdValid: boolean;
  signaturePresent: boolean;
  signatureValid: boolean | null;
  signerTrusted: boolean;
  expectedDigest?: string;
  expectedReportId?: string;
  expectedSigner?: string;
  signer?: string;
  error?: string;
}>;

function parseExpectedSigner(value: unknown, path: string): Hex {
  const signer = stringValue(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error(`${path} must be a 20-byte EVM address`);
  return getAddress(signer) as Hex;
}

function verificationTrust(options?: AtlasReportVerificationOptions): Readonly<{ expectedSigner?: Hex; error?: string }> {
  try {
    if (options !== undefined) {
      const record = dataRecord(options, "verification options");
      exactKeys(record, [], ["expectedSigner"], "verification options");
      if (Object.prototype.hasOwnProperty.call(record, "expectedSigner") && record.expectedSigner !== undefined) {
        return { expectedSigner: parseExpectedSigner(record.expectedSigner, "verification options.expectedSigner") };
      }
    }
    const status = getAtlasSignerStatus();
    if (!status.valid) return { error: status.error || "Invalid Atlas signer configuration" };
    return { expectedSigner: status.trustedSigner };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyAtlasReport(value: unknown, options?: AtlasReportVerificationOptions): Promise<ReportVerification> {
  let report: AtlasReport;
  try {
    report = validateAtlasReportStructure(value);
  } catch (error) {
    return {
      valid: false,
      integrityValid: false,
      authentic: false,
      authenticityValid: false,
      structureValid: false,
      digestValid: false,
      reportIdValid: false,
      signaturePresent: false,
      signatureValid: null,
      signerTrusted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const expectedHex = sha256(canonicalStringify(report.body));
  const expectedDigest = `sha256:${expectedHex}`;
  const expectedReportId = `atlas_report_${expectedHex}`;
  const digestValid = report.integrity.digest === expectedDigest;
  const reportIdValid = report.reportId === expectedReportId;
  const integrityValid = digestValid && reportIdValid;
  const signaturePresent = report.integrity.signature !== undefined || report.integrity.signer !== undefined;
  let signatureValid: boolean | null = null;
  if (signaturePresent) {
    if (!report.integrity.signature || !report.integrity.signer) {
      signatureValid = false;
    } else {
      try {
        const recovered = await recoverMessageAddress({
          message: signingMessage(expectedHex),
          signature: report.integrity.signature,
        });
        signatureValid = recovered.toLowerCase() === report.integrity.signer.toLowerCase();
      } catch {
        signatureValid = false;
      }
    }
  }

  const trust = verificationTrust(options);
  const signerTrusted = Boolean(
    report.integrity.signer
      && trust.expectedSigner
      && report.integrity.signer.toLowerCase() === trust.expectedSigner.toLowerCase(),
  );
  const authentic = signatureValid === true && signerTrusted;
  const issues: string[] = [];
  if (!digestValid) issues.push("report body digest mismatch");
  if (!reportIdValid) issues.push("reportId does not match the report body digest");
  if (trust.error) issues.push(trust.error);
  if (!signaturePresent) issues.push("report is unsigned");
  else if (signatureValid !== true) issues.push("report signature is invalid or incomplete");
  else if (!trust.expectedSigner) issues.push("no trusted Atlas signer is configured");
  else if (!signerTrusted) issues.push("report signer is not trusted");

  return {
    valid: integrityValid && authentic,
    integrityValid,
    authentic,
    authenticityValid: authentic,
    structureValid: true,
    digestValid,
    reportIdValid,
    signaturePresent,
    signatureValid,
    signerTrusted,
    expectedDigest,
    expectedReportId,
    expectedSigner: trust.expectedSigner,
    signer: report.integrity.signer,
    ...(issues.length > 0 ? { error: issues.join("; ") } : {}),
  };
}
