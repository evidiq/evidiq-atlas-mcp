import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalStringify,
  createAtlasReport,
  getAtlasSignerStatus,
  verifyAtlasReport,
} from "../lib/atlas/report.js";
import { getOgConfig } from "../lib/og/config.js";
import { getArtifact, putJsonArtifact, validateArtifactStorage } from "../lib/atlas/artifacts.js";

const TEST_KEY = `0x${"11".repeat(32)}` as const;
const OTHER_KEY = `0x${"22".repeat(32)}` as const;
const SOURCE_DIGEST = `sha256:${"ab".repeat(32)}`;
let directory = "";
const originalSigner = process.env.ATLAS_SIGNER_PRIVATE_KEY;
const originalSignerAddress = process.env.ATLAS_SIGNER_ADDRESS;
const originalOgPrivateKey = process.env.OG_PRIVATE_KEY;
const originalOgChainId = process.env.OG_CHAIN_ID;
const originalOgStorageRpc = process.env.OG_STORAGE_RPC;
const originalOgStorageIndexer = process.env.OG_STORAGE_INDEXER;
const originalArtifacts = process.env.ATLAS_ARTIFACT_DIR;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atlas-test-"));
  await chmod(directory, 0o700);
  process.env.ATLAS_ARTIFACT_DIR = directory;
  process.env.ATLAS_SIGNER_PRIVATE_KEY = TEST_KEY;
  delete process.env.ATLAS_SIGNER_ADDRESS;
  delete process.env.OG_PRIVATE_KEY;
  delete process.env.OG_CHAIN_ID;
  delete process.env.OG_STORAGE_RPC;
  delete process.env.OG_STORAGE_INDEXER;
});

afterEach(async () => {
  if (originalSigner === undefined) delete process.env.ATLAS_SIGNER_PRIVATE_KEY;
  else process.env.ATLAS_SIGNER_PRIVATE_KEY = originalSigner;
  if (originalSignerAddress === undefined) delete process.env.ATLAS_SIGNER_ADDRESS;
  else process.env.ATLAS_SIGNER_ADDRESS = originalSignerAddress;
  if (originalOgPrivateKey === undefined) delete process.env.OG_PRIVATE_KEY;
  else process.env.OG_PRIVATE_KEY = originalOgPrivateKey;
  if (originalOgChainId === undefined) delete process.env.OG_CHAIN_ID;
  else process.env.OG_CHAIN_ID = originalOgChainId;
  if (originalOgStorageRpc === undefined) delete process.env.OG_STORAGE_RPC;
  else process.env.OG_STORAGE_RPC = originalOgStorageRpc;
  if (originalOgStorageIndexer === undefined) delete process.env.OG_STORAGE_INDEXER;
  else process.env.OG_STORAGE_INDEXER = originalOgStorageIndexer;
  if (originalArtifacts === undefined) delete process.env.ATLAS_ARTIFACT_DIR;
  else process.env.ATLAS_ARTIFACT_DIR = originalArtifacts;
  await rm(directory, { recursive: true, force: true });
});

function body(deterministic = true) {
  return {
    tool: "profile_dataset",
    engine: { name: "DuckDB" as const, version: "v1.5.5" },
    datasets: [{ name: "sample.csv", format: "csv", digest: SOURCE_DIGEST, bytes: 10, sourceKind: "inline" as const }],
    request: { operation: "profile" },
    result: { rows: 2, columns: ["id"] },
    methods: ["profile"],
    assumptions: [],
    warnings: [],
    reproducibility: {
      deterministic,
      sourceDigests: [SOURCE_DIGEST],
      sandboxProvider: "local-duckdb" as const,
    },
  };
}

function artifactPath(artifactId: string): string {
  return join(directory, `${artifactId}.json`);
}

describe("canonical Atlas reports and artifacts", () => {
  it("canonicalizes object key order deterministically", () => {
    expect(canonicalStringify({ z: 1, a: { d: 2, b: 1 } })).toBe('{"a":{"b":1,"d":2},"z":1}');
  });

  it("produces deterministic complete-body signatures and detects body tampering", async () => {
    const first = await createAtlasReport(body(false));
    const second = await createAtlasReport(body(false));
    expect(first).toEqual(second);
    await expect(verifyAtlasReport(first)).resolves.toMatchObject({
      valid: true,
      integrityValid: true,
      authentic: true,
      digestValid: true,
      reportIdValid: true,
      signatureValid: true,
      signerTrusted: true,
    });

    const tampered = structuredClone(first) as unknown as Record<string, unknown>;
    const tamperedBody = tampered.body as Record<string, unknown>;
    tamperedBody.result = { rows: 999 };
    await expect(verifyAtlasReport(tampered)).resolves.toMatchObject({
      valid: false,
      integrityValid: false,
      digestValid: false,
    });
  });

  it("keeps integrity separate from missing or untrusted authenticity", async () => {
    const stripped = structuredClone(await createAtlasReport(body()));
    delete (stripped.integrity as { signature?: string }).signature;
    await expect(verifyAtlasReport(stripped)).resolves.toMatchObject({
      valid: false,
      integrityValid: true,
      authentic: false,
      signaturePresent: true,
      signatureValid: false,
    });

    delete process.env.ATLAS_SIGNER_PRIVATE_KEY;
    const unsigned = await createAtlasReport(body());
    await expect(verifyAtlasReport(unsigned)).resolves.toMatchObject({
      valid: false,
      integrityValid: true,
      authentic: false,
      signaturePresent: false,
      signatureValid: null,
    });

    process.env.ATLAS_SIGNER_PRIVATE_KEY = OTHER_KEY;
    const forged = await createAtlasReport(body());
    process.env.ATLAS_SIGNER_PRIVATE_KEY = TEST_KEY;
    await expect(verifyAtlasReport(forged)).resolves.toMatchObject({
      valid: false,
      integrityValid: true,
      authentic: false,
      signatureValid: true,
      signerTrusted: false,
    });
  });

  it("accepts an explicit expected signer and validates configured signer identity", async () => {
    process.env.ATLAS_SIGNER_PRIVATE_KEY = OTHER_KEY;
    const report = await createAtlasReport(body());
    const expectedSigner = privateKeyToAccount(OTHER_KEY).address;
    delete process.env.ATLAS_SIGNER_PRIVATE_KEY;

    await expect(verifyAtlasReport(report, { expectedSigner })).resolves.toMatchObject({
      valid: true,
      integrityValid: true,
      authentic: true,
      expectedSigner,
    });

    process.env.ATLAS_SIGNER_ADDRESS = expectedSigner;
    expect(getAtlasSignerStatus()).toMatchObject({ valid: true, signingEnabled: false, verificationEnabled: true, trustedSigner: expectedSigner });
    await expect(verifyAtlasReport(report)).resolves.toMatchObject({ valid: true, authentic: true });

    process.env.ATLAS_SIGNER_PRIVATE_KEY = TEST_KEY;
    expect(getAtlasSignerStatus()).toMatchObject({ valid: false, signingEnabled: false });
  });

  it("rejects reportId, algorithm, canonicalization, and schema tampering", async () => {
    const report = await createAtlasReport(body());

    const reportIdTampered = structuredClone(report) as { reportId: string };
    reportIdTampered.reportId = `atlas_report_${"00".repeat(32)}`;
    await expect(verifyAtlasReport(reportIdTampered)).resolves.toMatchObject({
      valid: false,
      integrityValid: false,
      digestValid: true,
      reportIdValid: false,
    });

    const algorithmTampered = structuredClone(report) as unknown as { integrity: { algorithm: string } };
    algorithmTampered.integrity.algorithm = "sha512";
    await expect(verifyAtlasReport(algorithmTampered)).resolves.toMatchObject({ valid: false, structureValid: false });

    const canonicalizationTampered = structuredClone(report) as unknown as { integrity: { canonicalization: string } };
    canonicalizationTampered.integrity.canonicalization = "JCS";
    await expect(verifyAtlasReport(canonicalizationTampered)).resolves.toMatchObject({ valid: false, structureValid: false });

    const schemaTampered = structuredClone(report) as unknown as { body: { schemaVersion: string } };
    schemaTampered.body.schemaVersion = "evidiq.atlas.report.v2";
    await expect(verifyAtlasReport(schemaTampered)).resolves.toMatchObject({ valid: false, structureValid: false });
  });

  it("creates restrictive artifact storage and rejects unsafe directory modes", async () => {
    const configured = join(directory, "new-storage");
    process.env.ATLAS_ARTIFACT_DIR = configured;

    await expect(validateArtifactStorage()).resolves.toEqual({ directory: configured, ready: true });
    expect((await stat(configured)).mode & 0o777).toBe(0o700);

    await chmod(configured, 0o750);
    await expect(validateArtifactStorage()).rejects.toThrow("group or other users");
    await expect(putJsonArtifact("profile", { unsafe: true })).rejects.toThrow("group or other users");
  });

  it("rejects artifact storage with an intermediate symlink", async () => {
    const target = join(directory, "target");
    const alias = join(directory, "alias");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias, "dir");
    process.env.ATLAS_ARTIFACT_DIR = join(alias, "nested-storage");

    await expect(validateArtifactStorage()).rejects.toThrow("symbolic links");
  });

  it("rejects oversized artifacts before storage writes and oversized stored files", async () => {
    await expect(putJsonArtifact("research", { payload: "x".repeat(30 * 1024 * 1024) }))
      .rejects.toThrow("storage safety limit");
    await expect(readdir(directory)).resolves.toEqual([]);

    const stored = await putJsonArtifact("research", { compact: true });
    await truncate(artifactPath(stored.artifactId), (30 * 1024 * 1024) + 1);
    await expect(getArtifact(stored.artifactId)).rejects.toThrow("exceeds safety limit");
  }, 20_000);

  it("rejects artifact files with unsafe permissions or symlinked final paths", async () => {
    const unsafe = await putJsonArtifact("profile", { permissions: "unsafe" });
    await chmod(artifactPath(unsafe.artifactId), 0o640);
    await expect(getArtifact(unsafe.artifactId)).rejects.toThrow("permissions are not restrictive");

    const linked = await putJsonArtifact("query", { symlink: "rejected" });
    const linkedPath = artifactPath(linked.artifactId);
    const target = join(directory, "symlink-target.json");
    await rename(linkedPath, target);
    await symlink(target, linkedPath);
    await expect(getArtifact(linked.artifactId)).rejects.toThrow("symbolic link");
    await expect(putJsonArtifact("query", { symlink: "rejected" })).rejects.toThrow("symbolic link");
  });

  it("stores and verifies content-addressed artifacts", async () => {
    const first = await putJsonArtifact("profile", { b: 2, a: 1 });
    const second = await putJsonArtifact("profile", { a: 1, b: 2 });
    expect(first.artifactId).toBe(second.artifactId);
    await expect(getArtifact(first.artifactId)).resolves.toEqual(first);
    await expect(getArtifact("../etc/passwd")).rejects.toThrow("Invalid Atlas artifact ID");
  });

  it("rejects tampered artifact metadata, content, and corrupt existing objects", async () => {
    const metadata = await putJsonArtifact("profile", { stable: true });
    await writeFile(
      artifactPath(metadata.artifactId),
      canonicalStringify({ ...metadata, kind: "chart" }),
      "utf8",
    );
    await expect(getArtifact(metadata.artifactId)).rejects.toThrow("kind does not match its ID");
    await expect(putJsonArtifact("profile", { stable: true })).rejects.toThrow("kind does not match its ID");

    const content = await putJsonArtifact("query", { rows: [1, 2] });
    await writeFile(
      artifactPath(content.artifactId),
      canonicalStringify({ ...content, content: { rows: [1, 3] } }),
      "utf8",
    );
    await expect(getArtifact(content.artifactId)).rejects.toThrow("content does not match its ID");

    const bytes = await putJsonArtifact("research", { answer: 42 });
    await writeFile(
      artifactPath(bytes.artifactId),
      canonicalStringify({ ...bytes, bytes: bytes.bytes + 1 }),
      "utf8",
    );
    await expect(getArtifact(bytes.artifactId)).rejects.toThrow("byte length mismatch");
  });
});

describe("0G configuration", () => {
  it.each([
    ["zero", `0x${"0".repeat(64)}`],
    ["out-of-range scalar", "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"],
  ])("rejects a %s private key without exposing it", (_label, privateKey) => {
    process.env.OG_PRIVATE_KEY = privateKey;
    let message = "";

    try {
      getOgConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/OG_PRIVATE_KEY.*valid secp256k1/i);
    expect(message).not.toContain(privateKey);
  });

  it("accepts a valid secp256k1 private key", () => {
    process.env.OG_PRIVATE_KEY = TEST_KEY;

    expect(getOgConfig()).toMatchObject({
      privateKey: TEST_KEY,
      chainId: 16661,
      storageRpc: "https://evmrpc.0g.ai",
      storageIndexer: "https://indexer-storage-turbo.0g.ai",
    });
  });
});