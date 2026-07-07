import fs from "node:fs";
import path from "node:path";
import {
  PROFILE_ID_PATTERN,
  REGISTRY_VERSION,
  readJsonFile,
  registryPath,
  writeJsonFile
} from "./paths.js";

export function validateProfileId(id) {
  const normalized = String(id ?? "").trim();
  if (!PROFILE_ID_PATTERN.test(normalized)) {
    throw new Error(`invalid profile id: ${id}`);
  }
  return normalized;
}

function emptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    profiles: {}
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
}

export function readRegistry(env = process.env) {
  const filePath = registryPath(env);
  if (!fs.existsSync(filePath)) return emptyRegistry();
  const registry = readJsonFile(filePath);
  assertRegistryShape(registry);
  return registry;
}

export function writeRegistry(registry, env = process.env) {
  assertRegistryShape(registry);
  writeJsonFile(registryPath(env), registry);
}

export function validateTemplateFile(filePath) {
  const errors = [];
  if (!filePath || typeof filePath !== "string") {
    return {
      valid: false,
      errors: ["template path must be a non-empty string"]
    };
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) errors.push("template path is not a file");
  } catch {
    errors.push("template file does not exist");
  }

  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    errors.push("template file is not readable");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function addProfile(id, filePath, env = process.env) {
  const profileId = validateProfileId(id);
  if (!filePath) throw new Error("profile add requires a template path");
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
  const profile = registry.profiles[profileId];
  if (!profile) return null;
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

  const validation = validateTemplateFile(profile.path);
  if (!validation.valid) {
    throw new Error(`invalid template for ${profileId}: ${validation.errors.join("; ")}`);
  }

  return {
    id: profileId,
    path: profile.path,
    content: fs.readFileSync(profile.path, "utf8")
  };
}
