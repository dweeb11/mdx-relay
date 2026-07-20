export const RECOVERY_ACTIONS = Object.freeze({
  selectProfile: "select-profile",
  editNote: "edit-note",
  replaceImage: "replace-image",
  previewAgain: "preview-again",
  chooseRepository: "choose-repository",
  fixRepository: "fix-repository",
  restorePermissions: "restore-permissions",
  retry: "retry",
  cancel: "cancel",
  inspectRecovery: "inspect-recovery",
  restoreFromBackup: "restore-from-backup",
  pushAgain: "push-again",
  verifyRemote: "verify-remote",
  openTerminal: "open-terminal",
  leaveLocalCommit: "leave-local-commit",
} as const);

export type RecoveryAction =
  (typeof RECOVERY_ACTIONS)[keyof typeof RECOVERY_ACTIONS];

export type IssueSeverity = "warning" | "blocker";

export type IssueStage =
  | "profile"
  | "capture"
  | "markdown"
  | "image"
  | "worker"
  | "planning"
  | "sealing"
  | "storage"
  | "approval"
  | "repository"
  | "git"
  | "recovery"
  | "remote";

export const ISSUE_CODES = Object.freeze({
  invalidProfile: "INVALID_PROFILE",
  unsafePath: "UNSAFE_PATH",
  credentialUrl: "CREDENTIAL_URL",
  noteTooLarge: "NOTE_TOO_LARGE",
  sourceImageTooLarge: "SOURCE_IMAGE_TOO_LARGE",
  decodedImageTooLarge: "DECODED_IMAGE_TOO_LARGE",
  outputFileLimitExceeded: "OUTPUT_FILE_LIMIT_EXCEEDED",
  outputTooLarge: "OUTPUT_TOO_LARGE",
  totalOutputTooLarge: "TOTAL_OUTPUT_TOO_LARGE",
  decodedWorkLimitExceeded: "DECODED_WORK_LIMIT_EXCEEDED",
  summaryMissing: "SUMMARY_MISSING",
  duplicateMessageField: "DUPLICATE_MESSAGE_FIELD",
  mdxEscaped: "MDX_ESCAPED",
  unsupportedMarkdown: "UNSUPPORTED_MARKDOWN",
  invalidFrontmatter: "INVALID_FRONTMATTER",
  invalidMdx: "INVALID_MDX",
  unsupportedImage: "UNSUPPORTED_IMAGE",
  imageDecodeFailed: "IMAGE_DECODE_FAILED",
  imageEncodeFailed: "IMAGE_ENCODE_FAILED",
  workerImageTimeout: "WORKER_IMAGE_TIMEOUT",
  planBudgetExhausted: "PLAN_BUDGET_EXHAUSTED",
  staleDuringPlanning: "STALE_DURING_PLANNING",
  planNotFound: "PLAN_NOT_FOUND",
  planExpired: "PLAN_EXPIRED",
  storageTampered: "STORAGE_TAMPERED",
  storageWriteFailed: "STORAGE_WRITE_FAILED",
  staleApproval: "STALE_APPROVAL",
  approvalMismatch: "APPROVAL_MISMATCH",
  repositoryPreflightFailed: "REPOSITORY_PREFLIGHT_FAILED",
  dirtyRepository: "DIRTY_REPOSITORY",
  unsupportedRepository: "UNSUPPORTED_REPOSITORY",
  hostileGitConfig: "HOSTILE_GIT_CONFIG",
  targetChanged: "TARGET_CHANGED",
  gitExecutionFailed: "GIT_EXECUTION_FAILED",
  rollbackFailed: "ROLLBACK_FAILED",
  recoveryRequired: "RECOVERY_REQUIRED",
  localCommitOnly: "LOCAL_COMMIT_ONLY",
  remoteStatusUnknown: "REMOTE_STATUS_UNKNOWN",
} as const);

export type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES];

export interface IssueDefinition {
  readonly severity: IssueSeverity;
  readonly stage: IssueStage;
  readonly recoveryActions: readonly RecoveryAction[];
}

const defineIssueRegistry = <T extends Record<IssueCode, IssueDefinition>>(
  registry: T,
): Readonly<T> => {
  for (const definition of Object.values(registry)) {
    Object.freeze(definition.recoveryActions);
    Object.freeze(definition);
  }
  return Object.freeze(registry);
};

const editNote = [RECOVERY_ACTIONS.editNote] as RecoveryAction[];
const replaceImage = [RECOVERY_ACTIONS.replaceImage] as RecoveryAction[];
const previewAgain = [RECOVERY_ACTIONS.previewAgain] as RecoveryAction[];
const fixRepository = [RECOVERY_ACTIONS.fixRepository] as RecoveryAction[];
const inspectRecovery = [RECOVERY_ACTIONS.inspectRecovery] as RecoveryAction[];

export const ISSUE_REGISTRY = defineIssueRegistry({
  [ISSUE_CODES.invalidProfile]: {
    severity: "blocker",
    stage: "profile",
    recoveryActions: [RECOVERY_ACTIONS.selectProfile],
  },
  [ISSUE_CODES.unsafePath]: {
    severity: "blocker",
    stage: "profile",
    recoveryActions: [RECOVERY_ACTIONS.selectProfile],
  },
  [ISSUE_CODES.credentialUrl]: {
    severity: "blocker",
    stage: "profile",
    recoveryActions: [RECOVERY_ACTIONS.selectProfile],
  },
  [ISSUE_CODES.noteTooLarge]: {
    severity: "blocker",
    stage: "capture",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.sourceImageTooLarge]: {
    severity: "blocker",
    stage: "capture",
    recoveryActions: replaceImage,
  },
  [ISSUE_CODES.decodedImageTooLarge]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
  },
  [ISSUE_CODES.outputFileLimitExceeded]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.outputTooLarge]: {
    severity: "blocker",
    stage: "sealing",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.totalOutputTooLarge]: {
    severity: "blocker",
    stage: "sealing",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.decodedWorkLimitExceeded]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.summaryMissing]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.duplicateMessageField]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.mdxEscaped]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.unsupportedMarkdown]: {
    severity: "blocker",
    stage: "markdown",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.invalidFrontmatter]: {
    severity: "blocker",
    stage: "markdown",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.invalidMdx]: {
    severity: "blocker",
    stage: "markdown",
    recoveryActions: editNote,
  },
  [ISSUE_CODES.unsupportedImage]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
  },
  [ISSUE_CODES.imageDecodeFailed]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
  },
  [ISSUE_CODES.imageEncodeFailed]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
  },
  [ISSUE_CODES.workerImageTimeout]: {
    severity: "blocker",
    stage: "worker",
    recoveryActions: [RECOVERY_ACTIONS.retry, RECOVERY_ACTIONS.replaceImage],
  },
  [ISSUE_CODES.planBudgetExhausted]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.staleDuringPlanning]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.planNotFound]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.planExpired]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.storageTampered]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: [
      RECOVERY_ACTIONS.restorePermissions,
      RECOVERY_ACTIONS.previewAgain,
    ],
  },
  [ISSUE_CODES.storageWriteFailed]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: [RECOVERY_ACTIONS.retry, RECOVERY_ACTIONS.cancel],
  },
  [ISSUE_CODES.staleApproval]: {
    severity: "blocker",
    stage: "approval",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.approvalMismatch]: {
    severity: "blocker",
    stage: "approval",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.repositoryPreflightFailed]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: fixRepository,
  },
  [ISSUE_CODES.dirtyRepository]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: fixRepository,
  },
  [ISSUE_CODES.unsupportedRepository]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: [RECOVERY_ACTIONS.chooseRepository],
  },
  [ISSUE_CODES.hostileGitConfig]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: fixRepository,
  },
  [ISSUE_CODES.targetChanged]: {
    severity: "blocker",
    stage: "git",
    recoveryActions: previewAgain,
  },
  [ISSUE_CODES.gitExecutionFailed]: {
    severity: "blocker",
    stage: "git",
    recoveryActions: inspectRecovery,
  },
  [ISSUE_CODES.rollbackFailed]: {
    severity: "blocker",
    stage: "recovery",
    recoveryActions: inspectRecovery,
  },
  [ISSUE_CODES.recoveryRequired]: {
    severity: "blocker",
    stage: "recovery",
    recoveryActions: [
      RECOVERY_ACTIONS.restoreFromBackup,
      RECOVERY_ACTIONS.openTerminal,
    ],
  },
  [ISSUE_CODES.localCommitOnly]: {
    severity: "blocker",
    stage: "remote",
    recoveryActions: [
      RECOVERY_ACTIONS.pushAgain,
      RECOVERY_ACTIONS.verifyRemote,
      RECOVERY_ACTIONS.leaveLocalCommit,
    ],
  },
  [ISSUE_CODES.remoteStatusUnknown]: {
    severity: "blocker",
    stage: "remote",
    recoveryActions: [
      RECOVERY_ACTIONS.verifyRemote,
      RECOVERY_ACTIONS.openTerminal,
    ],
  },
});

export interface SourcePoint {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface SourceRange {
  readonly start: SourcePoint;
  readonly end: SourcePoint;
}

export interface RedactedDisplayDetails {
  readonly summary: string;
  readonly safeContext?: string;
}

export interface IssueLocation {
  readonly sourceRange?: SourceRange;
  readonly safePathLabel?: string;
}

export interface MdxRelayIssue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly stage: IssueStage;
  readonly displayDetails: RedactedDisplayDetails;
  readonly recoveryActions: readonly RecoveryAction[];
  readonly sourceRange?: SourceRange;
  readonly safePathLabel?: string;
}

const cloneSourcePoint = (point: SourcePoint): SourcePoint =>
  Object.freeze({
    line: point.line,
    column: point.column,
    offset: point.offset,
  });

const cloneSourceRange = (range: SourceRange): SourceRange =>
  Object.freeze({
    start: cloneSourcePoint(range.start),
    end: cloneSourcePoint(range.end),
  });

export function createIssue(
  code: IssueCode,
  displayDetails: RedactedDisplayDetails,
  location: IssueLocation = {},
): MdxRelayIssue {
  const definition = ISSUE_REGISTRY[code];
  const sourceRange = location.sourceRange
    ? { sourceRange: cloneSourceRange(location.sourceRange) }
    : {};
  const safePathLabel =
    typeof location.safePathLabel === "string"
      ? { safePathLabel: location.safePathLabel }
      : {};
  return Object.freeze({
    code,
    severity: definition.severity,
    stage: definition.stage,
    displayDetails: Object.freeze({ ...displayDetails }),
    recoveryActions: definition.recoveryActions,
    ...sourceRange,
    ...safePathLabel,
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("issue registry", () => {
    it("defines every code exactly once with immutable policy", () => {
      const codes = Object.values(ISSUE_CODES);

      expect(new Set(codes).size).toBe(codes.length);
      expect(Object.keys(ISSUE_REGISTRY).sort()).toEqual([...codes].sort());
      expect(Object.isFrozen(ISSUE_CODES)).toBe(true);
      expect(Object.isFrozen(RECOVERY_ACTIONS)).toBe(true);
      expect(Object.isFrozen(ISSUE_REGISTRY)).toBe(true);
      for (const definition of Object.values(ISSUE_REGISTRY)) {
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Object.isFrozen(definition.recoveryActions)).toBe(true);
      }
    });

    it("constructs redacted issues only from registry policy", () => {
      const issue = createIssue(ISSUE_CODES.staleDuringPlanning, {
        summary: "The note changed while planning.",
      });

      expect(issue).toMatchObject({
        code: ISSUE_CODES.staleDuringPlanning,
        severity: "blocker",
        stage: "planning",
        recoveryActions: [RECOVERY_ACTIONS.previewAgain],
      });
      expect(Object.isFrozen(issue)).toBe(true);
      expect(Object.isFrozen(issue.displayDetails)).toBe(true);
    });

    it("copies only allowlisted location fields from adversarial input", () => {
      const issue = createIssue(
        ISSUE_CODES.staleDuringPlanning,
        { summary: "The note changed while planning." },
        {
          code: ISSUE_CODES.summaryMissing,
          severity: "warning",
          stage: "markdown",
          displayDetails: { summary: "unsafe override" },
          recoveryActions: [RECOVERY_ACTIONS.cancel],
          safePathLabel: 123,
        } as unknown as IssueLocation,
      );

      expect(issue).toEqual({
        code: ISSUE_CODES.staleDuringPlanning,
        severity: "blocker",
        stage: "planning",
        displayDetails: { summary: "The note changed while planning." },
        recoveryActions: [RECOVERY_ACTIONS.previewAgain],
      });
    });

    it("deeply clones and freezes constructed issue data", () => {
      const displayDetails = {
        summary: "The note changed while planning.",
        safeContext: "line 3",
      };
      const sourceRange = {
        start: { line: 3, column: 2, offset: 14 },
        end: { line: 3, column: 8, offset: 20 },
      };
      const issue = createIssue(
        ISSUE_CODES.staleDuringPlanning,
        displayDetails,
        { sourceRange, safePathLabel: "notes/example.md" },
      );

      displayDetails.summary = "mutated";
      sourceRange.start.line = 99;
      sourceRange.end.offset = 99;

      expect(issue.displayDetails.summary).toBe(
        "The note changed while planning.",
      );
      expect(issue.sourceRange).toEqual({
        start: { line: 3, column: 2, offset: 14 },
        end: { line: 3, column: 8, offset: 20 },
      });
      expect(Object.isFrozen(issue)).toBe(true);
      expect(Object.isFrozen(issue.displayDetails)).toBe(true);
      expect(Object.isFrozen(issue.sourceRange)).toBe(true);
      expect(Object.isFrozen(issue.sourceRange?.start)).toBe(true);
      expect(Object.isFrozen(issue.sourceRange?.end)).toBe(true);
      expect(() => {
        (issue.displayDetails as { summary: string }).summary = "mutated";
      }).toThrow(TypeError);
      expect(() => {
        (issue as unknown as { code: string }).code =
          ISSUE_CODES.summaryMissing;
      }).toThrow(TypeError);
      expect(() => {
        (issue.sourceRange as unknown as { start: SourcePoint }).start = {
          line: 99,
          column: 99,
          offset: 99,
        };
      }).toThrow(TypeError);
      expect(() => {
        (issue.sourceRange?.start as { line: number }).line = 99;
      }).toThrow(TypeError);
      expect(() => {
        (issue.sourceRange?.end as { offset: number }).offset = 99;
      }).toThrow(TypeError);
      expect(() => {
        (
          ISSUE_CODES as unknown as { staleDuringPlanning: string }
        ).staleDuringPlanning = "MUTATED";
      }).toThrow(TypeError);
      expect(() => {
        (RECOVERY_ACTIONS as unknown as { previewAgain: string }).previewAgain =
          "mutated";
      }).toThrow(TypeError);
    });

    it("lint rejects adversarial contract, issue, and limit redefinitions", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          "export function ok() {}",
          "export function err() {}",
          "export function createIssue() {}",
          "export const generationTokenBrand = Symbol();",
          "export function matchesPlanIdentity() {}",
          "export interface SourceRange {}",
          'export type ExportPlanState = "ready";',
          "export class WorkerProcessRequest {}",
          "export const ISSUE_CODES = {};",
          "export const ISSUE_REGISTRY = {};",
          "export const MDX_RELAY_LIMITS = {};",
          "export type MdxRelayLimits = {};",
          "export const templateCode = `STALE_DURING_PLANNING`;",
          'export const concatenatedCode = "STALE_" + "DURING_PLANNING";',
        ].join("\n"),
        { filePath: "src/planning/contract-boundary-probe.ts" },
      );
      const boundaryMessages = result?.messages.filter(
        ({ ruleId }) => ruleId === "contracts/freeze-contracts",
      );

      expect(boundaryMessages).toHaveLength(14);
    });

    it("lint rejects exported aliases and destructured frozen bindings", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          "const localOk = () => {};",
          "export { localOk as ok };",
          "const source = { err: () => {} };",
          "export const { err } = source;",
        ].join("\n"),
        { filePath: "src/planning/export-bypass-probe.ts" },
      );
      const rejectedNames = result?.messages
        .filter(({ ruleId }) => ruleId === "contracts/freeze-contracts")
        .map(({ message }) => message.split(" is frozen", 1)[0])
        .sort();

      expect(rejectedNames).toEqual(["err", "ok"]);
    });

    it("lint freezes exported function APIs but allows local declarations", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          "function ok() {}",
          "function downstream() { function err() {} void err; }",
          "export function createIssue() {}",
          "export default function matchesPlanIdentity() {}",
          "function localAlias() {}",
          "export { localAlias as generationTokenBrand };",
          "void ok;",
          "void downstream;",
        ].join("\n"),
        { filePath: "src/planning/function-boundary-probe.ts" },
      );
      const rejectedNames = result?.messages
        .filter(({ ruleId }) => ruleId === "contracts/freeze-contracts")
        .map(({ message }) => message.split(" is frozen", 1)[0])
        .sort();

      expect(rejectedNames).toEqual([
        "createIssue",
        "generationTokenBrand",
        "matchesPlanIdentity",
      ]);
    });

    it("lint rejects nested destructured frozen bindings", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          "const source = { nested: [] };",
          "export const { nested: [ok = undefined, ...err], ...SourceRange } = source;",
        ].join("\n"),
        { filePath: "src/planning/nested-binding-bypass-probe.ts" },
      );
      const rejectedNames = result?.messages
        .filter(({ ruleId }) => ruleId === "contracts/freeze-contracts")
        .map(({ message }) => message.split(" is frozen", 1)[0])
        .sort();

      expect(rejectedNames).toEqual(["SourceRange", "err", "ok"]);
    });

    it("lint rejects every contract export through independent syntax families", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const ts = await import("typescript");
      const { ESLint } = await import("eslint");
      const contractsRoot = path.join(process.cwd(), "src", "contracts");
      const contractFiles = fs
        .readdirSync(contractsRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => path.join(entry.parentPath, entry.name));
      const program = ts.createProgram(contractFiles, {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
      });
      const checker = program.getTypeChecker();
      // Intentional approval gate: contract API changes must update this exact snapshot.
      const lockedContractExportNames = [
        "ApprovalRecord",
        "CaptureFingerprint",
        "ExportAction",
        "ExportPlan",
        "ExportPlanState",
        "GenerationToken",
        "ISSUE_CODES",
        "ISSUE_REGISTRY",
        "IssueCode",
        "IssueDefinition",
        "IssueLocation",
        "IssueSeverity",
        "IssueStage",
        "MdxRelayIssue",
        "MdxRelayResult",
        "PlanId",
        "PlanIdentity",
        "RECOVERY_ACTIONS",
        "RecoveryAction",
        "RedactedDisplayDetails",
        "RepositoryFingerprint",
        "Result",
        "SealedBlob",
        "Sha256Digest",
        "SourceImageFingerprint",
        "SourcePoint",
        "SourceRange",
        "WorkerBlockedEvent",
        "WorkerCancelRequest",
        "WorkerCancelledEvent",
        "WorkerCompletedEvent",
        "WorkerEvent",
        "WorkerImageInput",
        "WorkerImageOutput",
        "WorkerProcessRequest",
        "WorkerProgressEvent",
        "WorkerRequest",
        "WorkerStartedEvent",
        "createIssue",
        "err",
        "generationTokenBrand",
        "matchesApprovalContext",
        "matchesPlanIdentity",
        "ok",
        "planIdBrand",
        "sha256Brand",
      ] as const;
      const exportedNames = [
        ...new Set(
          contractFiles.flatMap((filename) => {
            const sourceFile = program.getSourceFile(filename);
            const moduleSymbol =
              sourceFile && checker.getSymbolAtLocation(sourceFile);
            return moduleSymbol
              ? checker
                  .getExportsOfModule(moduleSymbol)
                  .map((symbol) => symbol.getName())
              : [];
          }),
        ),
      ].sort();
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      expect(exportedNames).toEqual(lockedContractExportNames);
      const probes = {
        alias: [
          ...lockedContractExportNames.map(
            (_, index) => `const localContract${index} = undefined;`,
          ),
          `export { ${lockedContractExportNames
            .map((name, index) => `localContract${index} as ${name}`)
            .join(", ")} };`,
        ].join("\n"),
        destructure: [
          "const source = {};",
          `export const { ${lockedContractExportNames.join(", ")} } = source;`,
        ].join("\n"),
        direct: lockedContractExportNames
          .map((name) => `export const ${name} = undefined;`)
          .join("\n"),
      };

      for (const [syntaxFamily, probe] of Object.entries(probes)) {
        const [result] = await eslint.lintText(probe, {
          filePath: `src/planning/full-contract-${syntaxFamily}-probe.ts`,
        });
        const rejectedNames = result?.messages
          .filter(({ ruleId }) => ruleId === "contracts/freeze-contracts")
          .map(({ message }) => message.split(" is frozen", 1)[0])
          .sort();

        expect(rejectedNames, syntaxFamily).toEqual(lockedContractExportNames);
      }
    });

    it("lint resolves static issue codes through const aliases", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          'const prefix = "STALE_";',
          'export const prefixedCode = prefix + "DURING_PLANNING";',
          "const chainedPrefix = prefix;",
          'export const chainedCode = chainedPrefix + "DURING_PLANNING";',
          'const planning = "PLANNING";',
          "export const templatedCode = `STALE_DURING_${planning}`;",
        ].join("\n"),
        { filePath: "src/planning/static-issue-alias-probe.ts" },
      );
      const issueMessages = result?.messages.filter(
        ({ messageId, ruleId }) =>
          ruleId === "contracts/freeze-contracts" && messageId === "issueCode",
      );

      expect(issueMessages).toHaveLength(3);
    });

    it("lint unwraps transparent TypeScript wrappers in static issue codes", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          'const assertedPrefix = "STALE_" as const;',
          'export const assertedCode = assertedPrefix + "DURING_PLANNING";',
          'const satisfiedPrefix = "STALE_" satisfies string;',
          'export const satisfiedCode = satisfiedPrefix + "DURING_PLANNING";',
          'const angleAssertedPrefix = <const>"STALE_";',
          'export const angleAssertedCode = angleAssertedPrefix + "DURING_PLANNING";',
          'const nonNullPrefix = "STALE_"!;',
          'export const nonNullCode = nonNullPrefix + "DURING_PLANNING";',
          'const planning = "PLANNING" as const;',
          "export const templatedCode = `STALE_DURING_${planning}`;",
        ].join("\n"),
        { filePath: "src/planning/wrapped-static-issue-probe.ts" },
      );
      const issueMessages = result?.messages.filter(
        ({ messageId, ruleId }) =>
          ruleId === "contracts/freeze-contracts" && messageId === "issueCode",
      );

      expect(issueMessages).toHaveLength(5);
    });

    it("lint does not treat mutable or dynamic issue-code expressions as static", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          'let mutablePrefix = "STALE_";',
          'export const mutableCode = mutablePrefix + "DURING_PLANNING";',
          'const reassignedPrefix = "STALE_";',
          'reassignedPrefix = "OTHER_";',
          'export const reassignedCode = reassignedPrefix + "DURING_PLANNING";',
          "const cycleA = cycleB;",
          "const cycleB = cycleA;",
          'export const cyclicCode = cycleA + "DURING_PLANNING";',
          'export const externalCode = externalPrefix + "DURING_PLANNING";',
          "const dynamicPrefix = getPrefix();",
          'export const dynamicCode = dynamicPrefix + "DURING_PLANNING";',
          "const objectPrefix = values.prefix;",
          'export const propertyCode = objectPrefix + "DURING_PLANNING";',
          'const conditionalPrefix = enabled ? "STALE_" : "FRESH_";',
          'export const conditionalCode = conditionalPrefix + "DURING_PLANNING";',
          "const wrappedDynamicPrefix = getPrefix() as string;",
          'export const wrappedDynamicCode = wrappedDynamicPrefix + "DURING_PLANNING";',
          "const satisfiedDynamicPrefix = getPrefix() satisfies string;",
          'export const satisfiedDynamicCode = satisfiedDynamicPrefix + "DURING_PLANNING";',
        ].join("\n"),
        { filePath: "src/planning/dynamic-issue-alias-probe.ts" },
      );
      const issueMessages = result?.messages.filter(
        ({ messageId, ruleId }) =>
          ruleId === "contracts/freeze-contracts" && messageId === "issueCode",
      );

      expect(issueMessages).toHaveLength(0);
    });

    it("lint allows frozen names as ordinary non-exported local bindings", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          "const ok = undefined;",
          "function downstream() {",
          "  const ok = undefined;",
          "  const { err } = { err: undefined };",
          "  const localHandler = function createIssue() { return err; };",
          "  const LocalPlan = class ExportPlan {};",
          "  return { ok, localHandler, LocalPlan };",
          "}",
          "try { throw { err: undefined }; } catch ({ err }) { void err; }",
          "void ok;",
          "void downstream;",
        ].join("\n"),
        { filePath: "src/planning/local-binding-probe.ts" },
      );
      const boundaryMessages = result?.messages.filter(
        ({ ruleId }) => ruleId === "contracts/freeze-contracts",
      );

      expect(boundaryMessages).toHaveLength(0);
    });

    it("lint rejects canonical contract wildcard re-exports uniformly", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });

      for (const [name, probe] of Object.entries({
        namespace: 'export * as resultContracts from "../contracts/result";',
        namespaceJs:
          'export * as resultContracts from "../contracts/result.js";',
        wildcard: 'export * from "../contracts/result";',
        wildcardJs: 'export * from "../contracts/result.js";',
      })) {
        const [result] = await eslint.lintText(probe, {
          filePath: `src/planning/canonical-${name}-re-export-probe.ts`,
        });
        const boundaryMessages = result?.messages.filter(
          ({ ruleId }) => ruleId === "contracts/freeze-contracts",
        );

        expect(boundaryMessages, name).toHaveLength(1);
      }
    });

    it("lint allows unrelated wildcard re-exports", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });

      for (const [name, probe] of Object.entries({
        local: 'export * from "./unrelated-local-module";',
        package: 'export * from "some-package";',
      })) {
        const [result] = await eslint.lintText(probe, {
          filePath: `src/planning/unrelated-${name}-re-export-probe.ts`,
        });
        const boundaryMessages = result?.messages.filter(
          ({ ruleId }) => ruleId === "contracts/freeze-contracts",
        );

        expect(boundaryMessages, name).toHaveLength(0);
      }
    });

    it("lint allows downstream imports and references to frozen contracts", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          'import type { SourceRange, WorkerProcessRequest } from "../contracts";',
          'import { createIssue, ISSUE_CODES } from "../contracts/issues";',
          'import { matchesPlanIdentity } from "../contracts/export-plan";',
          'import { err, ok } from "../contracts/result";',
          "export type PlanningInput = Readonly<{",
          "  range: SourceRange;",
          "  request: WorkerProcessRequest;",
          "  code: typeof ISSUE_CODES.staleDuringPlanning;",
          "}>;",
          "void createIssue;",
          "void matchesPlanIdentity;",
          "void err;",
          "void ok;",
        ].join("\n"),
        { filePath: "src/planning/contract-reference-probe.ts" },
      );
      const boundaryMessages = result?.messages.filter(
        ({ ruleId }) => ruleId === "contracts/freeze-contracts",
      );

      expect(boundaryMessages).toHaveLength(0);
    });
  });
}
