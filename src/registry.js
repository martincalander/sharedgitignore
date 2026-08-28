import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateTemplateContent } from "./block.js";
import {
  ensureDir,
  PROFILE_ID_PATTERN,
  REGISTRY_VERSION,
  readJsonFile,
  registryPath,
  writeJsonFile
} from "./paths.js";

const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export function validateProfileId(id) {
  if (typeof id !== "string" || !PROFILE_ID_PATTERN.test(id)) {
    throw new Error(`invalid profile id: ${id}`);
  }
  return id;
}

function emptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    profiles: Object.create(null)
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockPath(env) {
  return `${registryPath(env)}.lock`;
}

function lockMetadata() {
  return {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    token: crypto.randomBytes(16).toString("hex")
  };
}

function closeQuietly(descriptor) {
  try {
    fs.closeSync(descriptor);
  } catch {
    // Preserve the operation that caused cleanup.
  }
}

function createRegistryLock(filePath) {
  let descriptor = null;
  let stat = null;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
    stat = fs.fstatSync(descriptor, { bigint: true });
    const metadata = lockMetadata();
    const content = `${JSON.stringify(metadata)}\n`;
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    return { descriptor, filePath, stat, token: metadata.token };
  } catch (error) {
    if (descriptor !== null) {
      closeQuietly(descriptor);
      if (stat !== null) {
        try {
          const current = fs.lstatSync(filePath, { bigint: true });
          if (sameFileIdentity(current, stat)) fs.unlinkSync(filePath);
        } catch {
          // Preserve the lock creation error.
        }
      }
    }
    throw error;
  }
}

function readLockSnapshot(filePath) {
  let pathStat;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  if (pathStat.isSymbolicLink()) throw new Error(`refusing symbolic-link registry lock: ${filePath}`);
  if (!pathStat.isFile()) throw new Error(`refusing non-file registry lock: ${filePath}`);

  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, "r");
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(pathStat, descriptorStat)) return null;
    const content = fs.readFileSync(descriptor, "utf8");
    let metadata = null;
    try {
      metadata = JSON.parse(content);
    } catch {
      // A new owner may not have finished writing its metadata yet.
    }
    return { stat: descriptorStat, metadata };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== null) closeQuietly(descriptor);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    return true;
  }
}

function waitForRegistryLock() {
  Atomics.wait(REGISTRY_LOCK_WAIT, 0, 0, 10 + crypto.randomInt(11));
}

function registryLockTimeoutMessage(filePath, snapshot) {
  const metadata = snapshot?.metadata;
  if (metadata
    && metadata.hostname === os.hostname()
    && Number.isSafeInteger(metadata.pid)
    && metadata.pid > 0
    && !processIsAlive(metadata.pid)) {
    return `registry lock was left by terminated process ${metadata.pid}: ${filePath}; remove it after verifying no profile command is running`;
  }
  return `timed out waiting for registry lock: ${filePath}`;
}

function acquireRegistryLock(env) {
  const filePath = lockPath(env);
  ensureDir(path.dirname(filePath));
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      return createRegistryLock(filePath);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }

    if (Date.now() >= deadline) {
      const snapshot = readLockSnapshot(filePath);
      if (snapshot === null) continue;
      throw new Error(registryLockTimeoutMessage(filePath, snapshot));
    }
    waitForRegistryLock();
  }
}

function releaseRegistryLock(lock) {
  fs.closeSync(lock.descriptor);
  const current = readLockSnapshot(lock.filePath);
  if (!current
    || !sameFileIdentity(current.stat, lock.stat)
    || current.metadata?.token !== lock.token) {
    throw new Error(`registry lock changed while held: ${lock.filePath}`);
  }
  fs.unlinkSync(lock.filePath);
}

function withRegistryLock(env, operation) {
  const lock = acquireRegistryLock(env);
  let result;
  let operationError = null;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }

  try {
    releaseRegistryLock(lock);
  } catch (releaseError) {
    if (operationError === null) throw releaseError;
  }
  if (operationError !== null) throw operationError;
  return result;
}

function assertRegistryShape(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("registry must be a JSON object");
  }
  if (registry.version !== REGISTRY_VERSION) {
    throw new Error(`registry version must be ${REGISTRY_VERSION}`);
  }
  if (!registry.profiles || typeof registry.profiles !== "object" || Array.isArray(registry.profiles)) {
    throw new Error("registry profiles must be an object");
  }

  const registryKeys = Object.keys(registry).sort();
  if (registryKeys.length !== 2 || registryKeys[0] !== "profiles" || registryKeys[1] !== "version") {
    throw new Error("registry must contain exactly version and profiles");
  }

  for (const [id, profile] of Object.entries(registry.profiles)) {
    try {
      validateProfileId(id);
    } catch {
      throw new Error(`registry contains invalid profile id: ${id}`);
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`registry profile ${id} must be an object`);
    }
    const profileKeys = Object.keys(profile);
    if (profileKeys.length !== 1 || profileKeys[0] !== "path") {
      throw new Error(`registry profile ${id} must contain exactly path`);
    }
    if (typeof profile.path !== "string" || profile.path.length === 0 || !path.isAbsolute(profile.path)) {
      throw new Error(`registry profile ${id} path must be an absolute non-empty string`);
    }
    if (profile.path.includes("\u0000")) {
      throw new Error(`registry profile ${id} path must not contain NUL bytes`);
    }
  }
}

function normalizeRegistry(registry) {
  assertRegistryShape(registry);
  const normalized = emptyRegistry();
  for (const [id, profile] of Object.entries(registry.profiles)) {
    normalized.profiles[id] = { path: profile.path };
  }
  return normalized;
}

export function readRegistry(env = process.env) {
  const filePath = registryPath(env);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return emptyRegistry();
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing symbolic-link registry: ${filePath}`);
  if (!stat.isFile()) throw new Error(`refusing non-file registry: ${filePath}`);
  return normalizeRegistry(readJsonFile(filePath));
}

function writeRegistryUnlocked(registry, env) {
  writeJsonFile(registryPath(env), normalizeRegistry(registry));
}

export function writeRegistry(registry, env = process.env) {
  const normalized = normalizeRegistry(registry);
  withRegistryLock(env, () => writeRegistryUnlocked(normalized, env));
}

function inspectTemplateFile(filePath) {
  const errors = [];
  if (!filePath || typeof filePath !== "string") {
    return {
      valid: false,
      errors: ["template path must be a non-empty string"],
      bytes: null,
      content: null
    };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) errors.push("template path is not a file");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      errors.push("template file does not exist");
    } else {
      const code = error && typeof error === "object" && error.code ? ` (${error.code})` : "";
      errors.push(`cannot inspect template file${code}`);
    }
  }

  if (!stat?.isFile()) {
    return { valid: false, errors, bytes: null, content: null };
  }

  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && error.code ? ` (${error.code})` : "";
    errors.push(`template file is not readable${code}`);
    return { valid: false, errors, bytes: null, content: null };
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    errors.push("template must not contain a byte-order mark");
  }

  let content = null;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push("template must contain valid UTF-8");
  }

  if (content !== null) errors.push(...validateTemplateContent(content));

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    bytes,
    content
  };
}

export function validateTemplateFile(filePath) {
  const inspected = inspectTemplateFile(filePath);
  return { valid: inspected.valid, errors: inspected.errors };
}

export function addProfile(id, filePath, env = process.env) {
  const profileId = validateProfileId(id);
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("profile add requires a template path");
  }
  const resolvedPath = path.resolve(filePath);
  const validation = validateTemplateFile(resolvedPath);
  if (!validation.valid) {
    throw new Error(`invalid template for ${profileId}: ${validation.errors.join("; ")}`);
  }

  return withRegistryLock(env, () => {
    const currentValidation = validateTemplateFile(resolvedPath);
    if (!currentValidation.valid) {
      throw new Error(`invalid template for ${profileId}: ${currentValidation.errors.join("; ")}`);
    }
    const registry = readRegistry(env);
    registry.profiles[profileId] = { path: resolvedPath };
    writeRegistryUnlocked(registry, env);
    return {
      id: profileId,
      path: resolvedPath
    };
  });
}

export function removeProfile(id, env = process.env) {
  const profileId = validateProfileId(id);
  return withRegistryLock(env, () => {
    const registry = readRegistry(env);
    const existed = Object.prototype.hasOwnProperty.call(registry.profiles, profileId);
    delete registry.profiles[profileId];
    writeRegistryUnlocked(registry, env);
    return existed;
  });
}

export function getProfile(id, env = process.env) {
  const profileId = validateProfileId(id);
  const registry = readRegistry(env);
  if (!Object.hasOwn(registry.profiles, profileId)) return null;
  const profile = registry.profiles[profileId];
  return {
    id: profileId,
    path: profile.path
  };
}

export function listProfiles(env = process.env) {
  const registry = readRegistry(env);
  return Object.entries(registry.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, profile]) => ({
      id,
      path: profile.path
    }));
}

export function profileStatus(env = process.env) {
  return listProfiles(env).map((profile) => {
    const validation = validateTemplateFile(profile.path);
    return {
      ...profile,
      valid: validation.valid,
      errors: validation.errors
    };
  });
}

export function readProfileTemplate(id, env = process.env) {
  const profileId = validateProfileId(id);
  const profile = getProfile(profileId, env);
  if (!profile) throw new Error(`unknown profile: ${profileId}`);

  const inspected = inspectTemplateFile(profile.path);
  if (!inspected.valid) {
    throw new Error(`invalid template for ${profileId}: ${inspected.errors.join("; ")}`);
  }

  return {
    id: profileId,
    path: profile.path,
    content: inspected.content,
    bytes: inspected.bytes
  };
}
