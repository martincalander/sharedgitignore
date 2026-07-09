import fs from "node:fs";
import path from "node:path";
import { validateTemplateContent } from "./block.js";
import {
  PROFILE_ID_PATTERN,
  REGISTRY_VERSION,
  readJsonFile,
  registryPath,
  writeJsonFile
} from "./paths.js";

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

export function writeRegistry(registry, env = process.env) {
  writeJsonFile(registryPath(env), normalizeRegistry(registry));
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
  } catch {
    errors.push("template file does not exist");
  }

  if (!stat?.isFile()) {
    return { valid: false, errors, bytes: null, content: null };
  }

  let bytes;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    bytes = fs.readFileSync(filePath);
  } catch {
    errors.push("template file is not readable");
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

  const registry = readRegistry(env);
  registry.profiles[profileId] = { path: resolvedPath };
  writeRegistry(registry, env);
  return {
    id: profileId,
    path: resolvedPath
  };
}

export function removeProfile(id, env = process.env) {
  const profileId = validateProfileId(id);
  const registry = readRegistry(env);
  const existed = Object.prototype.hasOwnProperty.call(registry.profiles, profileId);
  delete registry.profiles[profileId];
  writeRegistry(registry, env);
  return existed;
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
