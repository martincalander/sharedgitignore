import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_VERSION = 1;
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) throw new Error(`path is not a directory: ${dirPath}`);
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function destinationMode(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write symbolic link: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`refusing to write non-file: ${filePath}`);
    }
    return stat.mode & 0o7777;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function flushDirectoryBestEffort(dirPath) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(dirPath, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms and filesystems do not support opening or syncing directories.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The file replacement has already completed.
      }
    }
  }
}

export function atomicWriteFile(filePath, content, {
  beforeRename = null,
  mode = 0o666,
  createParent = true,
  preserveMode = true
} = {}) {
  const parent = path.dirname(filePath);
  if (createParent) ensureDir(parent);
  const existingMode = destinationMode(filePath);
  const outputMode = existingMode !== null && preserveMode ? existingMode : mode;
  const temporaryPath = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor = null;

  try {
    descriptor = fs.openSync(temporaryPath, "wx", outputMode);
    fs.writeFileSync(descriptor, content);
    if (existingMode !== null || !preserveMode) fs.fchmodSync(descriptor, outputMode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (beforeRename !== null) beforeRename();
    if (destinationMode(filePath) !== existingMode) {
      throw new Error(`destination mode or existence changed during atomic write: ${filePath}`);
    }
    fs.renameSync(temporaryPath, filePath);
    flushDirectoryBestEffort(parent);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function writeJsonFile(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    preserveMode: false
  });
}

function homeDir() {
  return os.homedir();
}

export function sharedgitignoreHome(env = process.env) {
  return path.resolve(env.SHAREDGITIGNORE_HOME || path.join(homeDir(), ".sharedgitignore"));
}

export function registryPath(env = process.env) {
  return path.join(sharedgitignoreHome(env), "registry.json");
}

function childProcessErrorMessage(error) {
  if (!error || typeof error !== "object") return "";
  const stderr = typeof error.stderr === "string"
    ? error.stderr
    : (Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "");
  return stderr.trim();
}

function isSameOrDescendant(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseGitRepositoryRoot(output, cwd) {
  if (typeof output !== "string" || !output.endsWith("\n")) {
    throw new Error(`Git returned an invalid repository root for: ${cwd}`);
  }

  const withoutLineFeed = output.slice(0, -1);
  const candidates = [withoutLineFeed];
  if (withoutLineFeed.endsWith("\r")) candidates.push(withoutLineFeed.slice(0, -1));

  let realCwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch (error) {
    const detail = error && typeof error === "object" && error.code ? ` (${error.code})` : "";
    throw new Error(`cannot resolve repository path: ${cwd}${detail}`);
  }

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      const resolvedCandidate = path.resolve(candidate);
      const stat = fs.statSync(resolvedCandidate);
      if (!stat.isDirectory()) continue;
      const realCandidate = fs.realpathSync(resolvedCandidate);
      if (isSameOrDescendant(realCandidate, realCwd)) return realCandidate;
    } catch {
      // A CRLF alternative or a concurrently removed path may not exist.
    }
  }

  throw new Error(`Git returned a repository root that does not contain: ${cwd}`);
}

export function repoRootForCwd(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  let output;
  try {
    output = execFileSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("Git is required but was not found on PATH");
    }
    const detail = childProcessErrorMessage(error);
    throw new Error(`not a Git repository: ${resolved}${detail ? `: ${detail}` : ""}`);
  }
  return parseGitRepositoryRoot(output, resolved);
}

export function gitignorePath(repoRoot) {
  return path.join(repoRoot, ".gitignore");
}
