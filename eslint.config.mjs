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

const contractFiles = fs
  .readdirSync(CONTRACTS_ROOT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => path.join(entry.parentPath, entry.name));
const exportProgram = ts.createProgram({
  rootNames: [...contractFiles, LIMITS_FILE],
  options: {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const exportChecker = exportProgram.getTypeChecker();
const exportedNames = (filename) => {
  const sourceFile = exportProgram.getSourceFile(filename);
  const moduleSymbol =
    sourceFile && exportChecker.getSymbolAtLocation(sourceFile);
  return moduleSymbol
    ? exportChecker
        .getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.getName())
    : [];
};

const frozenContractNames = new Set(contractFiles.flatMap(exportedNames));
const frozenIssueValueNames = new Set(exportedNames(ISSUES_FILE));
const frozenLimitNames = new Set(exportedNames(LIMITS_FILE));

const staticStringValue = (
  node,
  resolvedIdentifiers,
  constInitializers,
  visited = new Set(),
  depth = 0,
) => {
  if (depth > 100) {
    return undefined;
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "ChainExpression"
  ) {
    return staticStringValue(
      node.expression,
      resolvedIdentifiers,
      constInitializers,
      visited,
      depth + 1,
    );
  }
  if (node.type === "Identifier") {
    const variable = resolvedIdentifiers.get(node);
    const initializer = variable && constInitializers.get(variable);
    if (!variable || !initializer || visited.has(variable)) {
      return undefined;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(variable);
    return staticStringValue(
      initializer,
      resolvedIdentifiers,
      constInitializers,
      nextVisited,
      depth + 1,
    );
  }
  if (node.type === "TemplateLiteral") {
    let value = node.quasis[0]?.value.cooked;
    if (value === null || value === undefined) {
      return undefined;
    }
    for (const [index, expression] of node.expressions.entries()) {
      const expressionValue = staticStringValue(
        expression,
        resolvedIdentifiers,
        constInitializers,
        visited,
        depth + 1,
      );
      const nextQuasi = node.quasis[index + 1]?.value.cooked;
      if (expressionValue === undefined || nextQuasi == null) {
        return undefined;
      }
      value += expressionValue + nextQuasi;
    }
    return value;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringValue(
      node.left,
      resolvedIdentifiers,
      constInitializers,
      visited,
      depth + 1,
    );
    const right = staticStringValue(
      node.right,
      resolvedIdentifiers,
      constInitializers,
      visited,
      depth + 1,
    );
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
      wildcard:
        "Wildcard re-exports from src/contracts/** are frozen at the canonical contract boundary.",
    },
    schema: [],
  },
  create(context) {
    const filename = normalizePath(context.filename);
    if (!filename.startsWith(`${normalizePath(SOURCE_ROOT)}/`)) {
      return {};
    }

    const inContracts = filename.startsWith(normalizedContractsRoot);
    const resolvedIdentifiers = new Map();
    const constInitializers = new Map();
    const collectStaticBindings = () => {
      for (const scope of context.sourceCode.scopeManager.scopes) {
        for (const reference of scope.references) {
          if (reference.resolved) {
            resolvedIdentifiers.set(reference.identifier, reference.resolved);
          }
        }
        for (const variable of scope.variables) {
          const [definition] = variable.defs;
          if (
            variable.defs.length !== 1 ||
            definition?.type !== "Variable" ||
            definition.parent?.kind !== "const" ||
            definition.node.id.type !== "Identifier" ||
            !definition.node.init ||
            variable.references.some(
              (reference) => reference.isWrite() && !reference.init,
            )
          ) {
            continue;
          }
          constInitializers.set(variable, definition.node.init);
        }
      }
    };
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

    const isCanonicalContractSource = (source) => {
      if (typeof source !== "string" || !source.startsWith(".")) {
        return false;
      }

      const resolvedSource = path.resolve(path.dirname(filename), source);
      const candidates = [
        resolvedSource,
        `${resolvedSource}.ts`,
        path.join(resolvedSource, "index.ts"),
      ];
      return candidates.some((candidate) => {
        const normalizedCandidate = normalizePath(candidate);
        return (
          normalizedCandidate.startsWith(normalizedContractsRoot) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile()
        );
      });
    };

    const checkBindingPattern = (node) => {
      switch (node.type) {
        case "Identifier":
          reportName(node, node.name);
          break;
        case "ObjectPattern":
          for (const property of node.properties) {
            checkBindingPattern(
              property.type === "Property" ? property.value : property,
            );
          }
          break;
        case "ArrayPattern":
          for (const element of node.elements) {
            if (element) {
              checkBindingPattern(element);
            }
          }
          break;
        case "AssignmentPattern":
          checkBindingPattern(node.left);
          break;
        case "RestElement":
          checkBindingPattern(node.argument);
          break;
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
      const value = staticStringValue(
        node,
        resolvedIdentifiers,
        constInitializers,
      );
      if (value !== undefined && ISSUE_CODE_PATTERN.test(value)) {
        context.report({ node, messageId: "issueCode" });
      }
    };

    return {
      Program: collectStaticBindings,
      Literal: checkStaticIssueCode,
      TemplateLiteral: checkStaticIssueCode,
      BinaryExpression: checkStaticIssueCode,
      ExportNamedDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.exported) {
            const name =
              specifier.exported.type === "Identifier"
                ? specifier.exported.name
                : String(specifier.exported.value);
            reportName(specifier.exported, name);
          }
        }
      },
      ExportAllDeclaration(node) {
        if (isCanonicalContractSource(node.source.value)) {
          context.report({ node, messageId: "wildcard" });
        }
      },
      TSInterfaceDeclaration: checkNamedDeclaration,
      TSTypeAliasDeclaration: checkNamedDeclaration,
      TSEnumDeclaration: checkNamedDeclaration,
      TSModuleDeclaration(node) {
        if (node.id.type === "Identifier") {
          reportName(node.id, node.id.name);
        }
      },
      ClassDeclaration: checkNamedDeclaration,
      FunctionDeclaration(node) {
        const declaration = node.parent;
        if (
          (declaration.type === "ExportNamedDeclaration" ||
            declaration.type === "ExportDefaultDeclaration") &&
          declaration.declaration === node
        ) {
          checkNamedDeclaration(node);
        }
      },
      VariableDeclarator(node) {
        const declaration = node.parent;
        if (
          declaration.type === "VariableDeclaration" &&
          declaration.parent.type === "ExportNamedDeclaration" &&
          declaration.parent.declaration === declaration
        ) {
          checkBindingPattern(node.id);
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
