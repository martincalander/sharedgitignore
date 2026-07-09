export {
  BEGIN_MARKER_PREFIX,
  beginMarker,
  END_MARKER_PREFIX,
  END_MARKER,
  hasReservedMarkerPrefix,
  parseGitignore,
  renderBlock,
  renderGitignore,
  renderGitignoreBuffer,
  validateTemplateContent
} from "./block.js";

export {
  atomicWriteFile,
  gitignorePath,
  PROFILE_ID_PATTERN,
  readJsonFile,
  registryPath,
  repoRootForCwd,
  sharedgitignoreHome,
  writeJsonFile
} from "./paths.js";

export {
  addProfile,
  getProfile,
  listProfiles,
  profileStatus,
  readProfileTemplate,
  readRegistry,
  removeProfile,
  validateProfileId,
  validateTemplateFile,
  writeRegistry
} from "./registry.js";

export {
  checkAllRepositories,
  checkRepository,
  detectRepository,
  findGitRepositories,
  initRepository,
  syncAllRepositories,
  syncRepository
} from "./repo.js";

export {
  defaultZshCompletionDir,
  installZshCompletion,
  zshCompletionScript
} from "./completion.js";

export {
  main,
  parseArgs
} from "./cli.js";
