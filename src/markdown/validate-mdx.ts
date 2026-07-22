import { compile } from "@mdx-js/mdx";

import {
  createIssue,
  ISSUE_CODES,
  type MdxRelayIssue,
} from "../contracts/issues";
import { err, ok, type Result } from "../contracts/result";

type MdxCompiler = (
  source: string,
  options: Readonly<{ outputFormat: "function-body" }>,
) => PromiseLike<unknown> | unknown;

export async function validateMdx(
  source: string,
  compiler: MdxCompiler = compile,
): Promise<Result<undefined, MdxRelayIssue>> {
  try {
    await compiler(source, { outputFormat: "function-body" });
    return ok(undefined);
  } catch {
    return err(createIssue(ISSUE_CODES.invalidMdx));
  }
}
