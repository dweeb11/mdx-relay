import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";

import type {
  TargetEntryStat,
  TargetFolderFileSystem,
  TargetFolderWriteHandle,
} from "./target-folder-writer-types";

const classifyStat = (
  stats: Awaited<ReturnType<typeof lstat>>,
): TargetEntryStat => {
  const byteLength = Number(stats.size);
  if (stats.isSymbolicLink()) return { kind: "symlink", byteLength };
  if (stats.isFile()) return { kind: "regularFile", byteLength };
  if (stats.isDirectory()) return { kind: "directory", byteLength };
  return { kind: "other", byteLength };
};

/**
 * Real Node adapter for disposable target-folder proofs. Uses `lstat` so
 * symlinked roots, parents, and targets are visible as links rather than as
 * their destinations. Never shells out to Git.
 */
export function createNodeTargetFolderFileSystem(): TargetFolderFileSystem {
  return {
    async resolveTargetRoot(configuredRoot) {
      const absolute = resolve(configuredRoot);
      const linkStat = await lstat(absolute);
      if (linkStat.isSymbolicLink())
        throw new Error("Target root must not be a symlink");
      if (!linkStat.isDirectory())
        throw new Error("Target root must be a directory");
      // realpath after refusing a final symlink collapses intermediate aliases
      // consistently with the sealed targetRootRealPath capture.
      return realpath(absolute);
    },
    async lstat(entryPath) {
      try {
        return classifyStat(await lstat(entryPath));
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return { kind: "absent" as const };
        throw error;
      }
    },
    readFile: async (filePath) => new Uint8Array(await readFile(filePath)),
    makeDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true });
    },
    async openForWrite(filePath) {
      const handle = await open(
        filePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o644,
      );
      const wrapped: TargetFolderWriteHandle = {
        write: async (bytes) => {
          await handle.write(bytes);
        },
        sync: async () => {
          await handle.sync();
        },
        close: async () => {
          await handle.close();
        },
      };
      return wrapped;
    },
    rename: (fromPath, toPath) => rename(fromPath, toPath),
    removeTemporary: async (entryPath) => {
      await rm(entryPath, { force: true });
    },
    listDirectory: (directoryPath) => readdir(directoryPath),
  };
}
