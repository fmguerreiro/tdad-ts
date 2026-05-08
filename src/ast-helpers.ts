import { SyntaxKind, type SourceFile } from "ts-morph";

export function stringLiteralValues(sourceFile: SourceFile): string[] {
  const out: string[] = [];
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    out.push(node.getLiteralValue());
  }
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    out.push(node.getLiteralValue());
  }
  return out;
}
