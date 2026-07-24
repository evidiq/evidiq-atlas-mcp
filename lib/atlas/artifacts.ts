import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import { canonicalStringify, sha256, type JsonValue } from "./report.js";

export type ArtifactKind = "report" | "chart" | "query" | "research" | "comparison" | "profile";

export type ArtifactRecord = Readonly<{
  artifactId: string;
  kind: ArtifactKind;
  digest: string;
  contentType: "application/json";
  bytes: number;
  content: JsonValue;
}>;

export type ArtifactStorageValidation = Readonly<{
  directory: string;
  ready: true;
}>;

const ARTIFACT_KINDS = new Set<ArtifactKind>(["report", "chart", "query", "research", "comparison", "profile"]);
const ID_PATTERN = /^atlas_(report|chart|query|research|comparison|profile)_([0-9a-f]{64})$/;
const MAX_STORED_ARTIFACT_BYTES = 30 * 1024 * 1024;
const ARTIFACT_DIRECTORY_MODE = 0o700;
const ARTIFACT_FILE_MODE = 0o600;
const NOFOLLOW_FLAG = process.platform === "linux" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = process.platform === "linux" && typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | NOFOLLOW_FLAG;
const CREATE_NOFOLLOW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG;
const READ_DIRECTORY_FLAGS = constants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG;

type UnknownRecord = Record<string, unknown>;

function artifactDirectory(): string {
  return resolve(process.env.ATLAS_ARTIFACT_DIR?.trim() || "/tmp/evidiq-atlas-artifacts");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function validateOwnership(metadata: Stats, label: string): void {
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) throw new Error(`${label} must be owned by the current process user`);
}

function validateDirectoryMetadata(metadata: Stats): void {
  if (!metadata.isDirectory()) throw new Error("Atlas artifact storage path is not a directory");
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Atlas artifact storage directory must not grant permissions to group or other users");
  }
  validateOwnership(metadata, "Atlas artifact storage directory");
}

function validateStoredFileMetadata(metadata: Stats, label: string): void {
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
  if ((metadata.mode & 0o7177) !== 0) throw new Error(`${label} permissions are not restrictive`);
  validateOwnership(metadata, label);
}

async function openNoFollow(path: string, flags: number, label: string, mode?: number) {
  try {
    return await open(path, flags, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${label} must not be a symbolic link`);
    throw error;
  }
}

async function existingDirectoryHasNoSymlinks(directory: string): Promise<boolean> {
  const root = parse(directory).root;
  const segments = relative(root, directory).split(sep).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error("Atlas artifact storage path must not contain symbolic links");
    if (!metadata.isDirectory()) {
      throw new Error(current === directory
        ? "Atlas artifact storage path is not a directory"
        : "Atlas artifact storage path contains a non-directory component");
    }
  }

  return true;
}

function artifactKind(value: unknown, path: string): ArtifactKind {
  if (typeof value !== "string" || !ARTIFACT_KINDS.has(value as ArtifactKind)) {
    throw new Error(`${path} must be a supported Atlas artifact kind`);
  }
  return value as ArtifactKind;
}

function plainRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
  return value as UnknownRecord;
}

function exactRecordKeys(record: UnknownRecord, expected: readonly string[], path: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error(`${path} has an invalid structure`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${path}.${key} is missing`);
  }
}

function parseArtifactId(artifactId: string): Readonly<{ kind: ArtifactKind; hash: string }> {
  const match = ID_PATTERN.exec(artifactId);
  if (!match?.[1] || !match[2]) throw new Error("Invalid Atlas artifact ID");
  return { kind: match[1] as ArtifactKind, hash: match[2] };
}

export function validateArtifactRecord(value: unknown, expectedArtifactId?: string): ArtifactRecord {
  const record = plainRecord(value, "Stored artifact");
  exactRecordKeys(record, ["artifactId", "kind", "digest", "contentType", "bytes", "content"], "Stored artifact");
  if (typeof record.artifactId !== "string") throw new Error("Stored artifact artifactId must be a string");
  if (expectedArtifactId !== undefined && record.artifactId !== expectedArtifactId) throw new Error("Stored artifact identity mismatch");

  const identity = parseArtifactId(record.artifactId);
  const kind = artifactKind(record.kind, "Stored artifact kind");
  if (kind !== identity.kind) throw new Error("Stored artifact kind does not match its ID");
  if (record.contentType !== "application/json") throw new Error("Stored artifact content type mismatch");
  if (typeof record.digest !== "string" || record.digest !== `sha256:${identity.hash}`) {
    throw new Error("Stored artifact digest does not match its ID");
  }
  if (typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    throw new Error("Stored artifact bytes must be a non-negative safe integer");
  }

  const canonicalContent = canonicalStringify(record.content);
  const contentHash = sha256(canonicalContent);
  if (contentHash !== identity.hash) throw new Error("Stored artifact content does not match its ID");
  if (record.digest !== `sha256:${contentHash}`) throw new Error("Stored artifact digest mismatch");
  if (record.bytes !== Buffer.byteLength(canonicalContent)) throw new Error("Stored artifact byte length mismatch");

  const normalizedContent = JSON.parse(canonicalContent) as JsonValue;
  if (canonicalStringify(normalizedContent) !== canonicalContent) throw new Error("Stored artifact content is not canonical JSON");
  return record as unknown as ArtifactRecord;
}

async function readStoredArtifact(path: string, expectedArtifactId: string): Promise<ArtifactRecord> {
  const handle = await openNoFollow(path, READ_NOFOLLOW_FLAGS, "Stored artifact");
  try {
    const metadata = await handle.stat();
    validateStoredFileMetadata(metadata, "Stored artifact");
    if (metadata.size > MAX_STORED_ARTIFACT_BYTES) throw new Error("Stored artifact exceeds safety limit");
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) !== metadata.size) throw new Error("Stored artifact changed while being read");
    const parsed = JSON.parse(raw) as unknown;
    const record = validateArtifactRecord(parsed, expectedArtifactId);
    if (canonicalStringify(record) !== raw) throw new Error("Stored artifact record is not canonically encoded");
    return record;
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await openNoFollow(directory, READ_DIRECTORY_FLAGS, "Atlas artifact storage directory");
  try {
    validateDirectoryMetadata(await handle.stat());
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function probeArtifactStorage(directory: string): Promise<void> {
  const probe = join(directory, `.atlas-storage-probe.${process.pid}.${randomUUID()}.tmp`);
  const payload = "atlas-artifact-storage-ready\n";
  let probeExists = false;

  try {
    const handle = await openNoFollow(probe, CREATE_NOFOLLOW_FLAGS, "Atlas artifact storage readiness probe", ARTIFACT_FILE_MODE);
    probeExists = true;
    try {
      await handle.chmod(ARTIFACT_FILE_MODE);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      const metadata = await handle.stat();
      validateStoredFileMetadata(metadata, "Atlas artifact storage readiness probe");
      if (metadata.size !== Buffer.byteLength(payload)) throw new Error("Atlas artifact storage readiness probe was not written completely");
    } finally {
      await handle.close();
    }

    await unlink(probe);
    probeExists = false;
    await fsyncDirectory(directory);
  } finally {
    if (probeExists) {
      try {
        await unlink(probe);
        await fsyncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export async function validateArtifactStorage(): Promise<ArtifactStorageValidation> {
  const directory = artifactDirectory();
  const existed = await existingDirectoryHasNoSymlinks(directory);
  let created = false;

  if (!existed) {
    try {
      created = (await mkdir(directory, { recursive: true, mode: ARTIFACT_DIRECTORY_MODE })) !== undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const canonicalDirectory = await realpath(directory);
  if (canonicalDirectory !== directory) throw new Error("Atlas artifact storage path must not contain symbolic links");

  const handle = await openNoFollow(directory, READ_DIRECTORY_FLAGS, "Atlas artifact storage directory");
  try {
    if (created) await handle.chmod(ARTIFACT_DIRECTORY_MODE);
    validateDirectoryMetadata(await handle.stat());
  } finally {
    await handle.close();
  }

  await probeArtifactStorage(directory);
  return { directory, ready: true };
}

export async function putJsonArtifact(kindInput: ArtifactKind, value: unknown): Promise<ArtifactRecord> {
  const kind = artifactKind(kindInput, "Artifact kind");
  const canonical = canonicalStringify(value);
  const content = JSON.parse(canonical) as JsonValue;
  const hash = sha256(canonical);
  const artifactId = `atlas_${kind}_${hash}`;
  const record: ArtifactRecord = {
    artifactId,
    kind,
    digest: `sha256:${hash}`,
    contentType: "application/json",
    bytes: Buffer.byteLength(canonical),
    content,
  };
  const encoded = canonicalStringify(record);
  const encodedBytes = Buffer.byteLength(encoded);
  if (encodedBytes > MAX_STORED_ARTIFACT_BYTES) throw new Error("Encoded Atlas artifact exceeds storage safety limit");
  validateArtifactRecord(record, artifactId);

  const { directory } = await validateArtifactStorage();
  const destination = join(directory, `${artifactId}.json`);
  const temporary = join(directory, `.${artifactId}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  let published = false;

  try {
    const handle = await openNoFollow(temporary, CREATE_NOFOLLOW_FLAGS, "Temporary Atlas artifact", ARTIFACT_FILE_MODE);
    temporaryExists = true;
    try {
      await handle.chmod(ARTIFACT_FILE_MODE);
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
      const metadata = await handle.stat();
      validateStoredFileMetadata(metadata, "Temporary Atlas artifact");
      if (metadata.size !== encodedBytes) throw new Error("Temporary Atlas artifact was not written completely");
    } finally {
      await handle.close();
    }

    try {
      await link(temporary, destination);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await getArtifact(artifactId);
      if (!existing) throw new Error("Existing Atlas artifact disappeared during publication");
      return existing;
    }
  } finally {
    if (temporaryExists) {
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (published) await fsyncDirectory(directory);
  }

  return record;
}

export async function getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
  parseArtifactId(artifactId);
  try {
    return await readStoredArtifact(join(artifactDirectory(), `${artifactId}.json`), artifactId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
