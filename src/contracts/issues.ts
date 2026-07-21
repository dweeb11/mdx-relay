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
  wikilinksFlattened: "WIKILINKS_FLATTENED",
  calloutsConverted: "CALLOUTS_CONVERTED",
  imageAltTextMissing: "IMAGE_ALT_TEXT_MISSING",
  unsupportedMarkdown: "UNSUPPORTED_MARKDOWN",
  invalidFrontmatter: "INVALID_FRONTMATTER",
  invalidMdx: "INVALID_MDX",
  unsupportedImage: "UNSUPPORTED_IMAGE",
  imageDecodeFailed: "IMAGE_DECODE_FAILED",
  imageEncodeFailed: "IMAGE_ENCODE_FAILED",
  workerImageTimeout: "WORKER_IMAGE_TIMEOUT",
  workerCrashed: "WORKER_CRASHED",
  malformedWorkerResponse: "MALFORMED_WORKER_RESPONSE",
  planBudgetExhausted: "PLAN_BUDGET_EXHAUSTED",
  staleDuringPlanning: "STALE_DURING_PLANNING",
  staleOutputsPresent: "STALE_OUTPUTS_PRESENT",
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
  /** Registry-owned display text. Callers cannot provide arbitrary strings. */
  readonly summary: string;
}

const defineIssueRegistry = <
  const T extends Record<IssueCode, IssueDefinition>,
>(
  registry: T,
): Readonly<T> => {
  for (const definition of Object.values(registry)) {
    Object.freeze(definition.recoveryActions);
    Object.freeze(definition);
  }
  return Object.freeze(registry);
};

const editNote = [RECOVERY_ACTIONS.editNote] as const;
const replaceImage = [RECOVERY_ACTIONS.replaceImage] as const;
const previewAgain = [RECOVERY_ACTIONS.previewAgain] as const;
const fixRepository = [RECOVERY_ACTIONS.fixRepository] as const;
const inspectRecovery = [RECOVERY_ACTIONS.inspectRecovery] as const;

export const ISSUE_REGISTRY = defineIssueRegistry({
  [ISSUE_CODES.invalidProfile]: {
    severity: "blocker",
    stage: "profile",
    recoveryActions: [RECOVERY_ACTIONS.selectProfile],
    summary: "The selected export profile is invalid.",
  },
  [ISSUE_CODES.unsafePath]: {
    severity: "blocker",
    stage: "profile",
    recoveryActions: [RECOVERY_ACTIONS.selectProfile],
    summary: "The configured path is unsafe.",
  },
  [ISSUE_CODES.credentialUrl]: {
    severity: "blocker",
    stage: "profile",
    recoveryActions: [RECOVERY_ACTIONS.selectProfile],
    summary: "A repository URL contains embedded credentials.",
  },
  [ISSUE_CODES.noteTooLarge]: {
    severity: "blocker",
    stage: "capture",
    recoveryActions: editNote,
    summary: "The source note exceeds the supported size limit.",
  },
  [ISSUE_CODES.sourceImageTooLarge]: {
    severity: "blocker",
    stage: "capture",
    recoveryActions: replaceImage,
    summary: "A source image exceeds the supported size limit.",
  },
  [ISSUE_CODES.decodedImageTooLarge]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
    summary: "A decoded image exceeds the supported pixel limit.",
  },
  [ISSUE_CODES.outputFileLimitExceeded]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: editNote,
    summary: "The plan exceeds the supported output file limit.",
  },
  [ISSUE_CODES.outputTooLarge]: {
    severity: "blocker",
    stage: "sealing",
    recoveryActions: editNote,
    summary: "A sealed output exceeds the supported size limit.",
  },
  [ISSUE_CODES.totalOutputTooLarge]: {
    severity: "blocker",
    stage: "sealing",
    recoveryActions: editNote,
    summary: "The sealed plan exceeds the total output size limit.",
  },
  [ISSUE_CODES.decodedWorkLimitExceeded]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: editNote,
    summary: "The plan exceeds the supported decoded-work limit.",
  },
  [ISSUE_CODES.summaryMissing]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "The source note has no summary.",
  },
  [ISSUE_CODES.duplicateMessageField]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "The source note contains duplicate message fields.",
  },
  [ISSUE_CODES.mdxEscaped]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "Unsafe MDX prose characters were escaped.",
  },
  [ISSUE_CODES.wikilinksFlattened]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "Obsidian wikilinks were flattened to text.",
  },
  [ISSUE_CODES.calloutsConverted]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "Obsidian callouts were converted to blockquotes.",
  },
  [ISSUE_CODES.imageAltTextMissing]: {
    severity: "warning",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "An embedded image has no alt text.",
  },
  [ISSUE_CODES.unsupportedMarkdown]: {
    severity: "blocker",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "The note contains unsupported Markdown or Obsidian syntax.",
  },
  [ISSUE_CODES.invalidFrontmatter]: {
    severity: "blocker",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "The note frontmatter is invalid.",
  },
  [ISSUE_CODES.invalidMdx]: {
    severity: "blocker",
    stage: "markdown",
    recoveryActions: editNote,
    summary: "The generated document is invalid MDX.",
  },
  [ISSUE_CODES.unsupportedImage]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
    summary: "An embedded image format is unsupported.",
  },
  [ISSUE_CODES.imageDecodeFailed]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
    summary: "An embedded image could not be decoded.",
  },
  [ISSUE_CODES.imageEncodeFailed]: {
    severity: "blocker",
    stage: "image",
    recoveryActions: replaceImage,
    summary: "An embedded image could not be encoded.",
  },
  [ISSUE_CODES.workerImageTimeout]: {
    severity: "blocker",
    stage: "worker",
    recoveryActions: [RECOVERY_ACTIONS.retry, RECOVERY_ACTIONS.replaceImage],
    summary: "Image processing exceeded its time budget.",
  },
  [ISSUE_CODES.workerCrashed]: {
    severity: "blocker",
    stage: "worker",
    recoveryActions: [RECOVERY_ACTIONS.retry, RECOVERY_ACTIONS.cancel],
    summary: "The processing worker stopped unexpectedly.",
  },
  [ISSUE_CODES.malformedWorkerResponse]: {
    severity: "blocker",
    stage: "worker",
    recoveryActions: [RECOVERY_ACTIONS.retry, RECOVERY_ACTIONS.cancel],
    summary: "The processing worker returned an invalid response.",
  },
  [ISSUE_CODES.planBudgetExhausted]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: previewAgain,
    summary: "Planning exceeded its total time budget.",
  },
  [ISSUE_CODES.staleDuringPlanning]: {
    severity: "blocker",
    stage: "planning",
    recoveryActions: previewAgain,
    summary: "Captured input changed while the plan was being built.",
  },
  [ISSUE_CODES.staleOutputsPresent]: {
    severity: "warning",
    stage: "planning",
    recoveryActions: [RECOVERY_ACTIONS.openTerminal],
    summary: "Unplanned stale outputs are present in the destination.",
  },
  [ISSUE_CODES.planNotFound]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: previewAgain,
    summary: "The sealed export plan could not be found.",
  },
  [ISSUE_CODES.planExpired]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: previewAgain,
    summary: "The sealed export plan has expired.",
  },
  [ISSUE_CODES.storageTampered]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: [
      RECOVERY_ACTIONS.restorePermissions,
      RECOVERY_ACTIONS.previewAgain,
    ],
    summary: "Private plan storage failed integrity or permission checks.",
  },
  [ISSUE_CODES.storageWriteFailed]: {
    severity: "blocker",
    stage: "storage",
    recoveryActions: [RECOVERY_ACTIONS.retry, RECOVERY_ACTIONS.cancel],
    summary: "The sealed export plan could not be stored safely.",
  },
  [ISSUE_CODES.staleApproval]: {
    severity: "blocker",
    stage: "approval",
    recoveryActions: previewAgain,
    summary: "The approval no longer matches the current preview.",
  },
  [ISSUE_CODES.approvalMismatch]: {
    severity: "blocker",
    stage: "approval",
    recoveryActions: previewAgain,
    summary: "The approval identity does not match the sealed plan.",
  },
  [ISSUE_CODES.repositoryPreflightFailed]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: fixRepository,
    summary: "Repository preflight could not be completed safely.",
  },
  [ISSUE_CODES.dirtyRepository]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: fixRepository,
    summary: "The destination repository is not clean.",
  },
  [ISSUE_CODES.unsupportedRepository]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: [RECOVERY_ACTIONS.chooseRepository],
    summary: "The destination repository form is unsupported.",
  },
  [ISSUE_CODES.hostileGitConfig]: {
    severity: "blocker",
    stage: "repository",
    recoveryActions: fixRepository,
    summary: "Git configuration or attributes could transform reviewed bytes.",
  },
  [ISSUE_CODES.targetChanged]: {
    severity: "blocker",
    stage: "git",
    recoveryActions: previewAgain,
    summary: "A planned target changed after preview.",
  },
  [ISSUE_CODES.gitExecutionFailed]: {
    severity: "blocker",
    stage: "git",
    recoveryActions: inspectRecovery,
    summary: "The verified Git operation failed.",
  },
  [ISSUE_CODES.rollbackFailed]: {
    severity: "blocker",
    stage: "recovery",
    recoveryActions: inspectRecovery,
    summary:
      "Automatic rollback could not restore the verified original state.",
  },
  [ISSUE_CODES.recoveryRequired]: {
    severity: "blocker",
    stage: "recovery",
    recoveryActions: [
      RECOVERY_ACTIONS.restoreFromBackup,
      RECOVERY_ACTIONS.openTerminal,
    ],
    summary: "A prior operation requires verified recovery.",
  },
  [ISSUE_CODES.localCommitOnly]: {
    severity: "blocker",
    stage: "remote",
    recoveryActions: [
      RECOVERY_ACTIONS.pushAgain,
      RECOVERY_ACTIONS.verifyRemote,
      RECOVERY_ACTIONS.leaveLocalCommit,
    ],
    summary: "The approved commit exists locally but was not published.",
  },
  [ISSUE_CODES.remoteStatusUnknown]: {
    severity: "blocker",
    stage: "remote",
    recoveryActions: [
      RECOVERY_ACTIONS.verifyRemote,
      RECOVERY_ACTIONS.openTerminal,
    ],
    summary: "The remote publication status could not be verified.",
  },
} as const);

export interface SourcePoint {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}
export interface SourceRange {
  readonly start: SourcePoint;
  readonly end: SourcePoint;
}

declare const safePathLabelBrand: unique symbol;
export type SafePathLabel = string & {
  readonly [safePathLabelBrand]: "SafePathLabel";
};

export interface IssueDisplayContext {
  /** The only caller-controlled display detail: a finite nonnegative integer. */
  readonly count?: number;
}

export interface RedactedDisplayDetails {
  readonly summary: string;
  readonly count?: number;
}

export interface IssueLocation {
  readonly sourceRange?: SourceRange;
  readonly safePathLabel?: SafePathLabel;
}

type IssueForCode<C extends IssueCode> = C extends IssueCode
  ? Readonly<{
      readonly code: C;
      readonly severity: (typeof ISSUE_REGISTRY)[C]["severity"];
      readonly stage: (typeof ISSUE_REGISTRY)[C]["stage"];
      readonly displayDetails: RedactedDisplayDetails;
      readonly recoveryActions: (typeof ISSUE_REGISTRY)[C]["recoveryActions"];
      readonly sourceRange?: SourceRange;
      readonly safePathLabel?: SafePathLabel;
    }>
  : never;

/** A distributive code-specific union whose policy is owned by ISSUE_REGISTRY. */
export type MdxRelayIssue<C extends IssueCode = IssueCode> = IssueForCode<C>;
export type WarningIssue = Extract<MdxRelayIssue, { severity: "warning" }>;
export type BlockerIssue = Extract<MdxRelayIssue, { severity: "blocker" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Number.isInteger(value) &&
  value >= 0;

/** Returns a branded label only for bounded normalized relative display paths. */
export function toSafePathLabel(value: unknown): SafePathLabel | undefined {
  if (typeof value !== "string") return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  if (
    value.length === 0 ||
    value.length > 240 ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value) ||
    /^[\\/]/u.test(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    value.includes("\\") ||
    /^(?:[^/@:\s]+@)?[^/@:\s]+:.+/u.test(value)
  ) {
    return undefined;
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  return value as SafePathLabel;
}

const clonePoint = (value: unknown): SourcePoint | undefined => {
  if (!isRecord(value)) return undefined;
  const { line, column, offset } = value;
  return isSafeInteger(line) && isSafeInteger(column) && isSafeInteger(offset)
    ? Object.freeze({ line, column, offset })
    : undefined;
};

const cloneRange = (value: unknown): SourceRange | undefined => {
  if (!isRecord(value)) return undefined;
  const start = clonePoint(value.start);
  const end = clonePoint(value.end);
  if (
    !start ||
    !end ||
    end.offset < start.offset ||
    end.line < start.line ||
    (end.line === start.line && end.column < start.column)
  ) {
    return undefined;
  }
  return Object.freeze({ start, end });
};

export function createIssue<C extends IssueCode>(
  code: C,
  context: IssueDisplayContext = {},
  location: unknown = {},
): MdxRelayIssue<C> {
  const safeCode =
    typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(ISSUE_REGISTRY, code)
      ? code
      : ISSUE_CODES.malformedWorkerResponse;
  const definition = ISSUE_REGISTRY[safeCode];
  const runtimeContext = isRecord(context) ? context : {};
  const count = isSafeInteger(runtimeContext.count)
    ? { count: runtimeContext.count }
    : {};
  const runtimeLocation = isRecord(location) ? location : {};
  const sourceRange = cloneRange(runtimeLocation.sourceRange);
  const safePathLabel = toSafePathLabel(runtimeLocation.safePathLabel);
  return Object.freeze({
    code: safeCode,
    severity: definition.severity,
    stage: definition.stage,
    displayDetails: Object.freeze({ summary: definition.summary, ...count }),
    recoveryActions: definition.recoveryActions,
    ...(sourceRange ? { sourceRange } : {}),
    ...(safePathLabel ? { safePathLabel } : {}),
  }) as MdxRelayIssue<C>;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("issue registry and construction", () => {
    it("locks every code, policy, summary, and approved snapshot", async () => {
      const { createHash } = await import("node:crypto");
      const snapshotHash = (value: unknown): string =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const codes = Object.values(ISSUE_CODES);
      expect(new Set(codes).size).toBe(codes.length);
      expect(Object.keys(ISSUE_REGISTRY).sort()).toEqual([...codes].sort());
      expect(Object.isFrozen(ISSUE_CODES)).toBe(true);
      expect(Object.isFrozen(RECOVERY_ACTIONS)).toBe(true);
      expect(Object.isFrozen(ISSUE_REGISTRY)).toBe(true);
      for (const definition of Object.values(ISSUE_REGISTRY)) {
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Object.isFrozen(definition.recoveryActions)).toBe(true);
        expect(definition.summary.length).toBeGreaterThan(0);
      }
      const policy = Object.entries(ISSUE_REGISTRY)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, definition]) => [
          code,
          definition.severity,
          definition.stage,
          [...definition.recoveryActions],
          definition.summary,
        ]);
      expect(snapshotHash([...codes].sort())).toBe(
        "35d1dac7ff51deb44300e383837787cddc82df329f75956dc8cf02e5c2bc11db",
      );
      expect(snapshotHash(Object.values(RECOVERY_ACTIONS).sort())).toBe(
        "235a3f3eb94625c1087d70b1687d03e3ed54725c88c57a23de77aec4faa36a1d",
      );
      // Intentional approval gate: fixed summaries are part of the exact policy snapshot.
      expect(snapshotHash(policy)).toBe(
        "dd0833b00016a6d0efee16bdf348a9c8c6348026b209e0add6b993ce3e9fe019",
      );
    });

    it("derives exact code policy and only accepts finite nonnegative counts", () => {
      const warning = createIssue(ISSUE_CODES.wikilinksFlattened, { count: 2 });
      const blocker = createIssue(ISSUE_CODES.invalidMdx);
      expect(warning).toMatchObject({
        code: ISSUE_CODES.wikilinksFlattened,
        severity: "warning",
        stage: "markdown",
        displayDetails: {
          summary: ISSUE_REGISTRY.WIKILINKS_FLATTENED.summary,
          count: 2,
        },
      });
      expect(blocker).toMatchObject({
        code: ISSUE_CODES.invalidMdx,
        severity: "blocker",
        stage: "markdown",
      });
      for (const malformed of [
        null,
        "secret",
        { count: -1 },
        { count: 1.5 },
        { count: Infinity },
        { count: "2" },
        { summary: "private note", safeContext: "token" },
      ]) {
        const issue = createIssue(ISSUE_CODES.invalidMdx, malformed as never);
        expect(issue.displayDetails).toEqual({
          summary: ISSUE_REGISTRY.INVALID_MDX.summary,
        });
      }
      expect(Object.isFrozen(warning)).toBe(true);
      expect(Object.isFrozen(warning.displayDetails)).toBe(true);
    });

    it("fails closed without leaking or throwing for an unknown runtime code", () => {
      const canary = "CALLER_SECRET_UNKNOWN_CODE";
      const issue = createIssue(canary as never, { summary: canary } as never, {
        safePathLabel: `https://user:token@example.test/${canary}`,
      });
      expect(issue).toMatchObject({
        code: ISSUE_CODES.malformedWorkerResponse,
        severity: "blocker",
        stage: "worker",
        displayDetails: {
          summary: ISSUE_REGISTRY.MALFORMED_WORKER_RESPONSE.summary,
        },
      });
      expect(JSON.stringify(issue)).not.toContain(canary);
    });

    it("validates safe path labels and rejects secret-bearing canaries", () => {
      const valid = [
        "notes/example.md",
        "assets/image-1.webp",
        "notes/reviewer@example.test.md",
        "a",
      ];
      for (const label of valid) expect(toSafePathLabel(label)).toBe(label);
      const invalid = [
        "",
        "/private/note.md",
        "\\\\server\\share",
        "C:\\secret.txt",
        "../secret",
        "notes/../secret",
        "notes//secret",
        "./secret",
        "https://user:token@example.test/repo",
        "git@example.test:owner/repo.git",
        "notes\\secret",
        "nul\0byte",
        "unit\u001fseparator",
        "delete\u007fcharacter",
        `notes/${"x".repeat(241)}`,
      ];
      for (const label of invalid)
        expect(toSafePathLabel(label), label).toBeUndefined();
      const canary = "https://user:token@example.test/private-note";
      const issue = createIssue(
        ISSUE_CODES.invalidMdx,
        { summary: canary, safeContext: canary } as never,
        { safePathLabel: canary, credentialUrl: canary },
      );
      expect(JSON.stringify(issue)).not.toContain(canary);
    });

    it("clones coherent source ranges and omits malformed optional locations", () => {
      const range = {
        start: { line: 1, column: 2, offset: 3 },
        end: { line: 2, column: 0, offset: 9 },
      };
      const label = toSafePathLabel("notes/example.md");
      expect(label).toBeDefined();
      const issue = createIssue(
        ISSUE_CODES.invalidMdx,
        {},
        { sourceRange: range, safePathLabel: label },
      );
      range.start.line = 99;
      expect(issue.sourceRange).toEqual({
        start: { line: 1, column: 2, offset: 3 },
        end: { line: 2, column: 0, offset: 9 },
      });
      expect(issue.safePathLabel).toBe(label);
      expect(Object.isFrozen(issue.sourceRange)).toBe(true);
      expect(Object.isFrozen(issue.sourceRange?.start)).toBe(true);
      for (const location of [
        null,
        false,
        { sourceRange: null },
        { sourceRange: true },
        { sourceRange: {} },
        { sourceRange: { start: {}, end: {} } },
        {
          sourceRange: {
            start: { line: -1, column: 0, offset: 0 },
            end: { line: 0, column: 0, offset: 0 },
          },
        },
        {
          sourceRange: {
            start: { line: 2, column: 0, offset: 9 },
            end: { line: 1, column: 0, offset: 3 },
          },
        },
        {
          sourceRange: {
            start: { line: 1, column: 8, offset: 3 },
            end: { line: 1, column: 2, offset: 9 },
          },
        },
      ]) {
        const malformed = createIssue(ISSUE_CODES.invalidMdx, {}, location);
        expect(malformed.sourceRange).toBeUndefined();
      }
    });

    it("table-drives frozen declaration, export, and re-export boundaries", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const frozenMessages = async (name: string, source: string) => {
        const [result] = await eslint.lintText(source, {
          filePath: `src/planning/freeze-${name}-probe.ts`,
        });
        return result?.messages.filter(
          ({ ruleId }) => ruleId === "contracts/freeze-contracts",
        );
      };
      const rejected = [
        ["interface", "interface SourceRange {}", "contract"],
        ["type", 'type ExportPlanState = "ready";', "contract"],
        ["enum", "enum WorkerRequest { Process }", "contract"],
        ["class", "class WorkerProcessRequest {}", "contract"],
        ["module", "namespace PlanIdentity {}", "contract"],
        ["function", "export function createIssue() {}", "contract"],
        [
          "default-function",
          "export default function matchesPlanIdentity() {}",
          "contract",
        ],
        [
          "destructure",
          "const source = { ok: 0 }; export const { ok } = source;",
          "contract",
        ],
        ["issue-codes-value", "export const ISSUE_CODES = {};", "contract"],
        [
          "issue-registry-value",
          "export const ISSUE_REGISTRY = {};",
          "contract",
        ],
        [
          "recovery-actions-value",
          "export const RECOVERY_ACTIONS = {};",
          "contract",
        ],
        ["limit-value", "export const MDX_RELAY_LIMITS = {};", "contract"],
        ["limit-type", "export type MdxRelayLimits = {};", "contract"],
        ["issue-code-literal", 'const code = "INVALID_MDX";', "issueCode"],
        [
          "contract-wildcard",
          'export * from "../contracts/result";',
          "wildcard",
        ],
        [
          "contract-wildcard-js",
          'export * from "../contracts/result.js";',
          "wildcard",
        ],
        [
          "contract-namespace",
          'export * as contracts from "../contracts/result";',
          "wildcard",
        ],
        [
          "contract-namespace-js",
          'export * as contracts from "../contracts/result.js";',
          "wildcard",
        ],
        ["limit-wildcard", 'export * from "../core/limits";', "wildcard"],
        ["limit-wildcard-js", 'export * from "../core/limits.js";', "wildcard"],
        [
          "limit-namespace",
          'export * as limits from "../core/limits";',
          "wildcard",
        ],
        [
          "limit-namespace-js",
          'export * as limits from "../core/limits.js";',
          "wildcard",
        ],
      ] as const;
      for (const [name, source, messageId] of rejected) {
        expect(await frozenMessages(name, source), name).toMatchObject([
          { messageId },
        ]);
      }
      const allowed = [
        [
          "canonical-imports",
          [
            'import type { SourceRange } from "../contracts/issues.js";',
            'import { createIssue } from "../contracts/issues.js";',
            'import { MDX_RELAY_LIMITS } from "../core/limits.js";',
            "void createIssue; void MDX_RELAY_LIMITS;",
          ].join("\n"),
        ],
        ["unrelated-wildcard", 'export * from "./unrelated.js";'],
        ["unrelated-namespace", 'export * as unrelated from "./unrelated.js";'],
        [
          "unrelated-re-export",
          'export { local as unrelatedName } from "./unrelated.js";',
        ],
        [
          "ordinary-locals",
          [
            "const ok = 1;",
            "function createIssue() { return ok; }",
            "const localFunction = function matchesPlanIdentity() { return ok; };",
            "const localClass = class ExportPlan {};",
            "void createIssue; void localFunction; void localClass;",
          ].join("\n"),
        ],
        [
          "private-brand-name-value",
          "export const generationTokenBrand = Symbol();",
        ],
        [
          "private-brand-name-alias",
          "const local = 0; export { local as planIdBrand };",
        ],
        [
          "unrelated-all-caps",
          'const UNRELATED_ALL_CAPS = "UNRELATED_ALL_CAPS"; void UNRELATED_ALL_CAPS;',
        ],
      ] as const;
      for (const [name, source] of allowed) {
        expect(await frozenMessages(name, source), name).toEqual([]);
      }
    });

    it("rejects static assembly, aliased unsafe casts, and shadowed code objects", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          'import { ISSUE_CODES as CODES, type IssueCode as Code } from "../contracts/issues.js";',
          'const joined = ["INVALID", "MDX"].join("_");',
          'const concatenated = "INVALID".concat("_", "MDX");',
          "const unsafeAs = getCode() as Code;",
          "const unsafeAngle = <Code>getCode();",
          "const legalAssertion = CODES.invalidMdx as Code;",
          "const shadowedLocal = (input: string) => { const ISSUE_CODES = { injected: input }; return ISSUE_CODES.injected as Code; };",
          "const shadowedParameter = (ISSUE_CODES: { injected: string }) => ISSUE_CODES.injected as Code;",
          "const handler = (code: Code): Code => code;",
          "type LocalCode = string; const localCast = getCode() as LocalCode;",
          "void joined; void concatenated; void unsafeAs; void unsafeAngle;",
          "void legalAssertion; void shadowedLocal; void shadowedParameter;",
          "void handler; void localCast;",
        ].join("\n"),
        { filePath: "src/planning/issue-code-bypass-probe.ts" },
      );
      const messages = result?.messages.filter(
        ({ ruleId }) => ruleId === "contracts/freeze-contracts",
      );
      expect(
        messages?.filter(({ messageId }) => messageId === "issueCode"),
      ).toHaveLength(2);
      expect(
        messages?.filter(({ messageId }) => messageId === "issueCodeCast"),
      ).toHaveLength(4);
      expect(messages).toHaveLength(6);
    });

    it("allows a canonical ISSUE_CODES alias as assertion provenance", async () => {
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({
        cwd: process.cwd(),
        overrideConfig: {
          languageOptions: { parserOptions: { projectService: false } },
        },
      });
      const [result] = await eslint.lintText(
        [
          'import { ISSUE_CODES as CODES, type IssueCode as Code } from "../contracts/issues.js";',
          "const legalAssertion = CODES.invalidMdx as Code;",
          "const handler = (code: Code): Code => code;",
          "void legalAssertion; void handler;",
        ].join("\n"),
        { filePath: "src/planning/legal-issue-code-alias-probe.ts" },
      );
      expect(
        result?.messages.filter(
          ({ ruleId }) => ruleId === "contracts/freeze-contracts",
        ),
      ).toEqual([]);
    });

    it("does not publish erased ambient values as runtime exports", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const ts = await import("typescript");
      const contractsRoot = path.join(process.cwd(), "src", "contracts");
      const contractFiles = fs
        .readdirSync(contractsRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => path.join(entry.parentPath, entry.name));
      const erasedRuntimeExports = contractFiles.flatMap((filename) => {
        const sourceFile = ts.createSourceFile(
          filename,
          fs.readFileSync(filename, "utf8"),
          ts.ScriptTarget.ES2022,
          true,
        );
        return sourceFile.statements.flatMap((statement) => {
          if (!ts.isVariableStatement(statement)) return [];
          const modifiers = statement.modifiers ?? [];
          const isExported = modifiers.some(
            ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
          );
          const isAmbient = modifiers.some(
            ({ kind }) => kind === ts.SyntaxKind.DeclareKeyword,
          );
          if (!isExported || !isAmbient) return [];
          /* v8 ignore next 4 -- failure-only diagnostic for forbidden exports */
          return statement.declarationList.declarations.map(
            (declaration) =>
              `${path.relative(contractsRoot, filename)}:${declaration.name.getText(sourceFile)}`,
          );
        });
      });

      expect(erasedRuntimeExports).toEqual([]);
    });

    it("locks the exact public contract export snapshot", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const ts = await import("typescript");
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
      const exportedNames = [
        ...new Set(
          contractFiles.flatMap((filename) =>
            checker
              .getExportsOfModule(
                checker.getSymbolAtLocation(program.getSourceFile(filename)!)!,
              )
              .map((symbol) => symbol.getName()),
          ),
        ),
      ].sort();
      // Intentional approval gate: contract API changes update this independent list.
      expect(exportedNames).toEqual([
        "ApprovalFingerprint",
        "ApprovalRecord",
        "ApprovalSealedOutputFingerprint",
        "ApprovalSourceImageFingerprint",
        "ApprovalSourceNoteFingerprint",
        "ApprovalTransitionIdentity",
        "ApprovedPriorTarget",
        "BlockedPreviewState",
        "BlockerIssue",
        "CanonicalDependencySnapshot",
        "CommitAuthorSnapshot",
        "DecodedWorkerCompletedEvent",
        "DecodedWorkerEvent",
        "ExportAction",
        "ExportPlan",
        "ExportPlanState",
        "GenerationToken",
        "GitFileMode",
        "GitRuntimeFingerprint",
        "ISSUE_CODES",
        "ISSUE_REGISTRY",
        "IssueCode",
        "IssueDefinition",
        "IssueDisplayContext",
        "IssueLocation",
        "IssueSeverity",
        "IssueStage",
        "MdxRelayErrorIssues",
        "MdxRelayIssue",
        "MdxRelayResult",
        "NoChangesExportPlan",
        "PlanId",
        "PlanIdentity",
        "RECOVERY_ACTIONS",
        "ReadyExportPlan",
        "RecoveryAction",
        "RedactedDisplayDetails",
        "RedactedRemoteFingerprint",
        "RepositoryBranchFingerprint",
        "RepositoryFingerprint",
        "RepositoryOidFingerprint",
        "RepositoryRealPaths",
        "RepositoryStateHashes",
        "RepositoryTargetFingerprint",
        "Result",
        "SafePathLabel",
        "SealedOutput",
        "Sha256Digest",
        "SourceImageMetadata",
        "SourceNoteMetadata",
        "SourcePoint",
        "SourceRange",
        "SupportedRepositoryFormChecks",
        "ValidatedPortableProfileSnapshot",
        "VerifiedReadyExportPlan",
        "WarningIssue",
        "WorkerBlockedEvent",
        "WorkerCancelRequest",
        "WorkerCancelledEvent",
        "WorkerCompletedWireEvent",
        "WorkerCompletion",
        "WorkerGeneratedMdxOutput",
        "WorkerImageInput",
        "WorkerImageOutput",
        "WorkerProcessRequest",
        "WorkerProgressEvent",
        "WorkerRequest",
        "WorkerSourceNoteInput",
        "WorkerStartedEvent",
        "WorkerWireEvent",
        "createIssue",
        "err",
        "matchesApprovalContext",
        "matchesPlanIdentity",
        "mdxRelayErr",
        "mdxRelayOk",
        "ok",
        "toSafePathLabel",
      ]);
    });
  });
}
