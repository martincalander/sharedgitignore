import fs from "node:fs";
import {
  addProfile,
  listProfiles,
  profileStatus,
  removeProfile
} from "./registry.js";
import {
  checkAllRepositories,
  checkRepository,
  detectRepository,
  initRepository,
  syncAllRepositories,
  syncRepository
} from "./repo.js";

export function parseArgs(args) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { flags, positionals };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assertAllowedFlags(flags, allowed) {
  const allowedSet = new Set(allowed);
  for (const flag of Object.keys(flags)) {
    if (!allowedSet.has(flag)) throw new Error(`Unknown option: --${flag}`);
  }
}

function assertNoPositionals(positionals, label) {
  if (positionals.length > 0) throw new Error(`${label} does not accept positional arguments`);
}

function printProfileList(env) {
  const profiles = listProfiles(env);
  if (profiles.length === 0) {
    process.stdout.write("no profiles registered\n");
    return;
  }
  for (const profile of profiles) {
    process.stdout.write(`${profile.id}\t${profile.path}\n`);
  }
}

function printProfileStatus(env) {
  const statuses = profileStatus(env);
  if (statuses.length === 0) {
    process.stdout.write("no profiles registered\n");
    return;
  }
  for (const profile of statuses) {
    const state = profile.valid ? "ok" : `invalid: ${profile.errors.join("; ")}`;
    process.stdout.write(`${profile.id}\t${state}\t${profile.path}\n`);
  }
}

function handleProfileCommand(subcommand, flags, positionals, env) {
  if (subcommand === "add") {
    assertAllowedFlags(flags, []);
    const id = positionals[0];
    const templatePath = positionals[1];
    if (!id || !templatePath) throw new Error("profile add requires <id> <path>");
    if (positionals.length > 2) throw new Error("profile add accepts exactly <id> <path>");
    const profile = addProfile(id, templatePath, env);
    process.stdout.write(`${profile.id}\t${profile.path}\n`);
    return;
  }

  if (subcommand === "remove") {
    assertAllowedFlags(flags, []);
    const id = positionals[0];
    if (!id) throw new Error("profile remove requires <id>");
    if (positionals.length > 1) throw new Error("profile remove accepts exactly <id>");
    const removed = removeProfile(id, env);
    process.stdout.write(`${removed ? "removed" : "missing"}\t${id}\n`);
    return;
  }

  if (subcommand === "list") {
    assertAllowedFlags(flags, []);
    assertNoPositionals(positionals, "profile list");
    printProfileList(env);
    return;
  }

  if (subcommand === "status") {
    assertAllowedFlags(flags, []);
    assertNoPositionals(positionals, "profile status");
    printProfileStatus(env);
    return;
  }

  throw new Error(`Unknown profile command: ${subcommand || "(missing)"}`);
}

function printDetect(result) {
  process.stdout.write(`cwd: ${result.cwd}\n`);
  process.stdout.write(`repo root: ${result.repoRoot}\n`);
  process.stdout.write(`.gitignore: ${result.gitignoreExists ? result.gitignorePath : "(missing)"}\n`);
  process.stdout.write(`managed block: ${result.hasBlock ? "yes" : "no"}\n`);
  process.stdout.write(`profile: ${result.profile ?? "(none)"}\n`);
  process.stdout.write(`template: ${result.templatePath ?? "(unknown)"}\n`);
  process.stdout.write(`in sync: ${result.inSync === null ? "(unknown)" : (result.inSync ? "yes" : "no")}\n`);
  process.stdout.write(`errors: ${result.errors.join("; ") || "(none)"}\n`);
}

function printCheckResult(result) {
  if (result.valid) {
    process.stdout.write(`ok\t${result.profile}\t${result.gitignorePath}\n`);
    return;
  }

  process.stdout.write(`invalid\t${result.repoRoot}\n`);
  for (const error of result.errors) {
    process.stdout.write(`error\t${error}\n`);
  }
}

function printAllResults(results, mode) {
  for (const result of results) {
    if (result.skipped) {
      process.stdout.write(`skipped\t${result.repoRoot}\t${result.reason}\n`);
      continue;
    }

    if (mode === "check" && result.errors?.length === 1 && result.errors[0] === "managed block is stale") {
      process.stdout.write(`stale\t${result.profile}\t${result.repoRoot}\n`);
      continue;
    }

    if (result.errors && result.errors.length > 0) {
      process.stdout.write(`invalid\t${result.repoRoot}\t${result.errors.join("; ")}\n`);
      continue;
    }

    if (mode === "sync") {
      process.stdout.write(`${result.changed ? "updated" : "current"}\t${result.profile}\t${result.repoRoot}\n`);
    } else {
      process.stdout.write(`${result.valid ? "ok" : "stale"}\t${result.profile}\t${result.repoRoot}\n`);
    }
  }
}

function hasFailures(results, mode) {
  return results.some((result) => {
    if (result.skipped) return false;
    if (result.errors && result.errors.length > 0) return true;
    return mode === "check" && !result.valid;
  });
}

function help() {
  process.stdout.write(`sharedgitignore 1.0.0

Usage:
  sharedgitignore profile add <id> <path>
  sharedgitignore profile remove <id>
  sharedgitignore profile list
  sharedgitignore profile status
  sharedgitignore detect [--cwd path] [--json]
  sharedgitignore init --profile <id> [--cwd path]
  sharedgitignore sync [--cwd path]
  sharedgitignore check [--cwd path]
  sharedgitignore sync-all --root <path> [--no-recursive]
  sharedgitignore check-all --root <path> [--no-recursive]

sharedgitignore manages a generated shared block at the top of .gitignore.
Project-specific rules stay below the managed block.
sync-all and check-all recurse into nested Git repos by default.
\n`);
}

export async function main(args, env = process.env) {
  const { flags, positionals } = parseArgs(args);
  const command = positionals.shift() || "help";

  if (flags.help || command === "help") {
    assertAllowedFlags(flags, ["help"]);
    assertNoPositionals(positionals, "help");
    help();
    return;
  }

  if (command === "profile") {
    handleProfileCommand(positionals.shift(), flags, positionals, env);
    return;
  }

  if (command === "detect") {
    assertAllowedFlags(flags, ["cwd", "json"]);
    assertNoPositionals(positionals, "detect");
    const result = detectRepository({ cwd: flags.cwd || process.cwd(), env });
    if (flags.json) printJson(result);
    else printDetect(result);
    return;
  }

  if (command === "init") {
    assertAllowedFlags(flags, ["cwd", "profile"]);
    assertNoPositionals(positionals, "init");
    if (!flags.profile) throw new Error("init requires --profile <id>");
    const result = initRepository(flags.profile, { cwd: flags.cwd || process.cwd(), env });
    process.stdout.write(`${result.changed ? "initialized" : "current"}\t${result.profile}\t${result.gitignorePath}\n`);
    return;
  }

  if (command === "sync") {
    assertAllowedFlags(flags, ["cwd"]);
    assertNoPositionals(positionals, "sync");
    const result = syncRepository({ cwd: flags.cwd || process.cwd(), env });
    process.stdout.write(`${result.changed ? "updated" : "current"}\t${result.profile}\t${result.gitignorePath}\n`);
    return;
  }

  if (command === "check") {
    assertAllowedFlags(flags, ["cwd"]);
    assertNoPositionals(positionals, "check");
    const result = checkRepository({ cwd: flags.cwd || process.cwd(), env });
    printCheckResult(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (command === "sync-all") {
    assertAllowedFlags(flags, ["root", "no-recursive"]);
    assertNoPositionals(positionals, "sync-all");
    if (!flags.root) throw new Error("sync-all requires --root <path>");
    if (!fs.existsSync(flags.root)) throw new Error(`root does not exist: ${flags.root}`);
    const results = syncAllRepositories({ root: flags.root, recursive: !flags["no-recursive"], env });
    printAllResults(results, "sync");
    if (hasFailures(results, "sync")) process.exitCode = 1;
    return;
  }

  if (command === "check-all") {
    assertAllowedFlags(flags, ["root", "no-recursive"]);
    assertNoPositionals(positionals, "check-all");
    if (!flags.root) throw new Error("check-all requires --root <path>");
    if (!fs.existsSync(flags.root)) throw new Error(`root does not exist: ${flags.root}`);
    const results = checkAllRepositories({ root: flags.root, recursive: !flags["no-recursive"], env });
    printAllResults(results, "check");
    if (hasFailures(results, "check")) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
