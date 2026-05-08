import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import { Graph } from "./graph.js";
import { fileId } from "./parser.js";

export interface RoutePattern {
  fileId: string;
  url: string;
  match: RegExp;
}

const DEFAULT_FILE_NAMES = [
  "page.ts",
  "page.tsx",
  "route.ts",
  "route.tsx",
  "layout.ts",
  "layout.tsx",
];

export async function buildRouteTable(
  root: string,
  appDir: string,
  fileNames: string[] = DEFAULT_FILE_NAMES,
): Promise<RoutePattern[]> {
  const absoluteAppDir = path.resolve(root, appDir);
  if (!fs.existsSync(absoluteAppDir)) return [];

  const patterns = fileNames.map((name) => `**/${name}`);
  const found = await fg(patterns, {
    cwd: absoluteAppDir,
    absolute: true,
    dot: false,
  });

  const routes: RoutePattern[] = [];
  for (const absolute of found) {
    const relativeFromRoot = path.relative(root, absolute).split(path.sep).join("/");
    const url = derivePathFromAppFile(appDir, relativeFromRoot);
    if (url === undefined) continue;
    routes.push({
      fileId: fileId(relativeFromRoot),
      url,
      match: routeRegex(url),
    });
  }
  return routes;
}

export function derivePathFromAppFile(appDir: string, relativePath: string): string | undefined {
  const normalizedAppDir = appDir.replace(/\/$/, "").split("/").join("/");
  const prefix = `${normalizedAppDir}/`;
  if (!relativePath.startsWith(prefix)) return undefined;
  const inside = relativePath.slice(prefix.length);
  const segments = inside.split("/");
  segments.pop();
  const kept = segments.filter((segment) => !isRouteGroup(segment) && !isPrivate(segment));
  return "/" + kept.join("/");
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

function isPrivate(segment: string): boolean {
  return segment.startsWith("_");
}

export function routeRegex(url: string): RegExp {
  if (url === "/") return /^\/$/;
  const parts = url.slice(1).split("/").map((segment) => {
    if (segment.startsWith("[...") && segment.endsWith("]")) return ".+";
    if (segment.startsWith("[[...") && segment.endsWith("]]")) return ".*";
    if (segment.startsWith("[") && segment.endsWith("]")) return "[^/]+";
    return escapeRegex(segment);
  });
  return new RegExp("^/" + parts.join("/") + "/?$");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function emitRouteEdges(graph: Graph, project: Project, root: string, routes: RoutePattern[]): void {
  if (routes.length === 0) return;
  for (const sourceFile of project.getSourceFiles()) {
    const relativePath = path.relative(root, sourceFile.getFilePath()).split(path.sep).join("/");
    const callerId = fileId(relativePath);
    const callerNode = graph.nodes.get(callerId);
    if (!callerNode || callerNode.kind !== "File") continue;
    if (!callerNode.isTest) continue;
    for (const literal of stringLiterals(sourceFile)) {
      for (const route of routes) {
        if (route.match.test(literal)) {
          if (callerId === route.fileId) continue;
          if (graph.outgoing(callerId, "ROUTE").some((edge) => edge.to === route.fileId)) continue;
          graph.addEdge({ kind: "ROUTE", from: callerId, to: route.fileId });
        }
      }
    }
  }
}

function stringLiterals(sourceFile: SourceFile): string[] {
  const out: string[] = [];
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    out.push(node.getLiteralValue());
  }
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    out.push(node.getLiteralValue());
  }
  return out;
}
