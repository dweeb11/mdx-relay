import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const ISSUE_CODE_PATTERN = /^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/u;
const FROZEN_CONTRACT_NAMES = new Set([
  "ApprovalRecord",
  "CaptureFingerprint",
  "ExportAction",
  "ExportPlan",
  "GenerationToken",
  "IssueCode",
  "MdxRelayIssue",
  "MdxRelayResult",
  "PlanId",
  "RecoveryAction",
  "RepositoryFingerprint",
  "Result",
  "WorkerEvent",
  "WorkerRequest",
]);

const freezeContractsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep frozen contracts and issue-code literals in src/contracts.",
    },
    messages: {
      issueCode:
        "Reference ISSUE_CODES; issue-code literals are defined only in src/contracts/issues.ts.",
      contract:
        "{{name}} is a frozen contract and may only be declared in src/contracts.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (!filename.includes("/src/") || filename.includes("/src/contracts/")) {
      return {};
    }

    const checkDeclaration = (node) => {
      const name = node.id?.name;
      if (name && FROZEN_CONTRACT_NAMES.has(name)) {
        context.report({
          node: node.id,
          messageId: "contract",
          data: { name },
        });
      }
    };

    return {
      Literal(node) {
        if (
          typeof node.value === "string" &&
          ISSUE_CODE_PATTERN.test(node.value)
        ) {
          context.report({ node, messageId: "issueCode" });
        }
      },
      TSInterfaceDeclaration: checkDeclaration,
      TSTypeAliasDeclaration: checkDeclaration,
      TSEnumDeclaration: checkDeclaration,
      ClassDeclaration: checkDeclaration,
    };
  },
};

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: {
      contracts: {
        rules: {
          "freeze-contracts": freezeContractsRule,
        },
      },
    },
    rules: {
      "contracts/freeze-contracts": "error",
    },
  },
);
