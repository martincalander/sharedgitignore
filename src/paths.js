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

export function atomicWriteFile(filePath, content, { mode = 0o666 } = {}) {
  const parent = path.dirname(filePath);
  ensureDir(parent);
  const existingMode = destinationMode(filePath);
  const temporaryPath = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor = null;

  try {
    descriptor = fs.openSync(temporaryPath, "wx", existingMode ?? mode);
    fs.writeFileSync(descriptor, content);
    if (existingMode !== null) fs.fchmodSync(descriptor, existingMode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
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
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

export function repoRootForCwd(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  try {
    const output = execFileSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!output) throw new Error("empty git output");
    return path.resolve(output);
  } catch {
    throw new Error(`not a Git repository: ${resolved}`);
  }
}

export function gitignorePath(repoRoot) {
  return path.join(repoRoot, ".gitignore");
}
