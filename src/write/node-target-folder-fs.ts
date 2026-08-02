import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  TARGET_WRITE_TEMPORARY_SUFFIX,
  type OwnedTemporaryFile,
  type TargetEntryIdentity,
  type TargetEntryStat,
  type TargetFolderFileSystem,
  type TargetFolderWriteHandle,
} from "./target-folder-writer-types";

const identityOf = (stats: BigIntStats): TargetEntryIdentity => ({
  deviceId: stats.dev.toString(),
  inode: stats.ino.toString(),
});

const classifyStat = (stats: BigIntStats): TargetEntryStat => {
  const byteLength = Number(stats.size);
  const identity = identityOf(stats);
  if (stats.isSymbolicLink()) return { kind: "symlink", byteLength, identity };
  if (stats.isFile()) return { kind: "regularFile", byteLength, identity };
  if (stats.isDirectory()) return { kind: "directory", byteLength, identity };
  return { kind: "other", byteLength, identity };
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/** Number of exclusive-create attempts before a unique name is given up on. */
const TEMPORARY_NAME_ATTEMPTS = 8;

const uniqueTemporaryName = (baseName: string): string =>
  `${baseName}${TARGET_WRITE_TEMPORARY_SUFFIX}-${globalThis.crypto.randomUUID()}`;

/**
 * Writes the whole buffer. `FileHandle.write` may persist fewer bytes than
 * requested, so the caller-visible write only resolves once every sealed byte
 * has been accepted; a write that makes no progress fails instead of looping.
 *
 * Exported for unit proof of the short-write path, which no real local
 * filesystem reproduces on demand.
 */
export const writeAllBytes = async (
  handle: {
    write(
      buffer: Uint8Array,
      offset: number,
      length: number,
    ): Promise<{ bytesWritten: number }>;
  },
  bytes: Uint8Array,
): Promise<void> => {
  let written = 0;
  while (written < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
    );
    if (bytesWritten <= 0)
      throw new Error("Target write stalled before all sealed bytes landed.");
    written += bytesWritten;
  }
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
        return classifyStat(await lstat(entryPath, { bigint: true }));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { kind: "absent" as const };
        throw error;
      }
    },
    realPath: (entryPath) => realpath(entryPath),
    readFile: async (filePath) => new Uint8Array(await readFile(filePath)),
    makeDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true });
    },
    async createTemporary(directoryPath, baseName) {
      for (let attempt = 0; attempt < TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
        const filePath = join(directoryPath, uniqueTemporaryName(baseName));
        let handle;
        try {
          handle = await open(
            filePath,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW,
            0o600,
          );
        } catch (error) {
          // Only a name that is already taken is retried; every other failure
          // is a real write failure and must stay visible.
          if (errorCode(error) === "EEXIST") continue;
          throw error;
        }
        const wrapped: TargetFolderWriteHandle = {
          write: (bytes) => writeAllBytes(handle, bytes),
          identity: async () => identityOf(await handle.stat({ bigint: true })),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
        const owned: OwnedTemporaryFile = {
          path: filePath,
          identity: identityOf(await handle.stat({ bigint: true })),
          handle: wrapped,
        };
        return owned;
      }
      throw new Error("Could not create a unique temporary target file.");
    },
    rename: (fromPath, toPath) => rename(fromPath, toPath),
    async linkInto(fromPath, toPath) {
      try {
        await link(fromPath, toPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
      return true;
    },
    async removeOwnedTemporary(entryPath, identity) {
      let stats;
      try {
        stats = await lstat(entryPath, { bigint: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      // Never unlink a path that is no longer the file this writer created.
      const current = identityOf(stats);
      if (
        current.deviceId !== identity.deviceId ||
        current.inode !== identity.inode
      )
        return;
      await rm(entryPath, { force: true });
    },
    listDirectory: (directoryPath) => readdir(directoryPath),
  };
}
