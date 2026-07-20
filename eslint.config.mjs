import fs from "node:fs";
import path from "node:path";

import eslint from "@eslint/js";
import ts from "typescript";
import tseslint from "typescript-eslint";

const ISSUE_CODE_PATTERN = /^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/u;
const SOURCE_ROOT = path.join(import.meta.dirname, "src");
const CONTRACTS_ROOT = path.join(SOURCE_ROOT, "contracts");
const ISSUES_FILE = path.join(CONTRACTS_ROOT, "issues.ts");
const LIMITS_FILE = path.join(SOURCE_ROOT, "core", "limits.ts");

const normalizePath = (filename) =>
  path.resolve(filename).replaceAll("\\", "/");
const normalizedContractsRoot = `${normalizePath(CONTRACTS_ROOT)}/`;
const normalizedIssuesFile = normalizePath(ISSUES_FILE);
const normalizedLimitsFile = normalizePath(LIMITS_FILE);

const hasExportModifier = (node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
  );

const exportedTypeNames = (sourceFile) => {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (
      hasExportModifier(statement) &&
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
};

const exportedVariableNames = (sourceFile) => {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement) || !ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        names.push(declaration.name.text);
      }
    }
  }
  return names;
};

const parseSourceFile = (filename) =>
  ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

const contractFiles = fs
  .readdirSync(CONTRACTS_ROOT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => path.join(entry.parentPath, entry.name));

const frozenContractNames = new Set(
  contractFiles.flatMap((filename) =>
    exportedTypeNames(parseSourceFile(filename)),
  ),
);
const frozenIssueValueNames = new Set(
  exportedVariableNames(parseSourceFile(ISSUES_FILE)),
);
const frozenLimitNames = new Set([
  ...exportedTypeNames(parseSourceFile(LIMITS_FILE)),
  ...exportedVariableNames(parseSourceFile(LIMITS_FILE)),
]);

const staticStringValue = (node) => {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  if (node.type === "TemplateLiteral") {
    let value = node.quasis[0]?.value.cooked;
    if (value === null || value === undefined) {
      return undefined;
    }
    for (const [index, expression] of node.expressions.entries()) {
      const expressionValue = staticStringValue(expression);
      const nextQuasi = node.quasis[index + 1]?.value.cooked;
      if (expressionValue === undefined || nextQuasi == null) {
        return undefined;
      }
      value += expressionValue + nextQuasi;
    }
    return value;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const isNestedStaticString = (node) => {
  const parent = node.parent;
  return (
    (parent?.type === "BinaryExpression" && parent.operator === "+") ||
    parent?.type === "TemplateLiteral"
  );
};

const freezeContractsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep frozen contracts, limits, and issue-code literals at their canonical source boundaries.",
    },
    messages: {
      issueCode:
        "Reference ISSUE_CODES; issue-code literals are defined only in src/contracts/issues.ts.",
      contract: "{{name}} is frozen and may only be declared in {{location}}.",
    },
    schema: [],
  },
  create(context) {
    const filename = normalizePath(context.filename);
    if (!filename.startsWith(`${normalizePath(SOURCE_ROOT)}/`)) {
      return {};
    }

    const inContracts = filename.startsWith(normalizedContractsRoot);
    const declarationLocation = (name) => {
      if (frozenContractNames.has(name) && !inContracts) {
        return "src/contracts/**";
      }
      if (
        frozenIssueValueNames.has(name) &&
        filename !== normalizedIssuesFile
      ) {
        return "src/contracts/issues.ts";
      }
      if (frozenLimitNames.has(name) && filename !== normalizedLimitsFile) {
        return "src/core/limits.ts";
      }
      return undefined;
    };

    const reportName = (node, name) => {
      const location = declarationLocation(name);
      if (location) {
        context.report({
          node,
          messageId: "contract",
          data: { name, location },
        });
      }
    };

    const checkNamedDeclaration = (node) => {
      if (node.id?.name) {
        reportName(node.id, node.id.name);
      }
    };

    const checkStaticIssueCode = (node) => {
      if (filename === normalizedIssuesFile || isNestedStaticString(node)) {
        return;
      }
      const value = staticStringValue(node);
      if (value !== undefined && ISSUE_CODE_PATTERN.test(value)) {
        context.report({ node, messageId: "issueCode" });
      }
    };

    return {
      Literal: checkStaticIssueCode,
      TemplateLiteral: checkStaticIssueCode,
      BinaryExpression: checkStaticIssueCode,
      TSInterfaceDeclaration: checkNamedDeclaration,
      TSTypeAliasDeclaration: checkNamedDeclaration,
      TSEnumDeclaration: checkNamedDeclaration,
      TSModuleDeclaration(node) {
        if (node.id.type === "Identifier") {
          reportName(node.id, node.id.name);
        }
      },
      ClassDeclaration: checkNamedDeclaration,
      ClassExpression: checkNamedDeclaration,
      FunctionDeclaration: checkNamedDeclaration,
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") {
          reportName(node.id, node.id.name);
        }
      },
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
