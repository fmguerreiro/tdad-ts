import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, type SourceFile } from "ts-morph";
import { Graph, type FileNode } from "./graph.js";
import { fileId } from "./parser.js";
import { stringLiteralValues } from "./ast-helpers.js";

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
  if (!fs.existsSync(absoluteAppDir)) {
    throw new Error(`appDir not found: ${absoluteAppDir}`);
  }

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
  const segments = url.slice(1).split("/");
  let pattern = "^";
  for (const segment of segments) {
    if (segment.startsWith("[[...") && segment.endsWith("]]")) {
      // Optional catch-all: the leading slash is part of the optional group
      pattern += "(?:/.+)?";
    } else if (segment.startsWith("[...") && segment.endsWith("]")) {
      pattern += "/.+";
    } else if (segment.startsWith("[") && segment.endsWith("]")) {
      pattern += "/[^/]+";
    } else {
      pattern += "/" + escapeRegex(segment);
    }
  }
  pattern += "/?$";
  return new RegExp(pattern);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FileInGraph {
  sourceFile: SourceFile;
  relativePath: string;
  callerId: string;
  fileNode: FileNode;
}

export function forEachFileInGraph(
  graph: Graph,
  project: Project,
  root: string,
  callback: (entry: FileInGraph) => void,
): void {
  for (const sourceFile of project.getSourceFiles()) {
    const relativePath = path.relative(root, sourceFile.getFilePath()).split(path.sep).join("/");
    const callerId = fileId(relativePath);
    const callerNode = graph.nodes.get(callerId);
    if (!callerNode || callerNode.kind !== "File") continue;
    callback({ sourceFile, relativePath, callerId, fileNode: callerNode });
  }
}

export function addRouteEdgeOnce(graph: Graph, fromId: string, toId: string): void {
  if (fromId === toId) return;
  if (graph.outgoing(fromId, "ROUTE").some((edge) => edge.to === toId)) return;
  graph.addEdge({ kind: "ROUTE", from: fromId, to: toId });
}

export function emitRouteEdges(graph: Graph, project: Project, root: string, routes: RoutePattern[]): void {
  if (routes.length === 0) return;
  forEachFileInGraph(graph, project, root, ({ sourceFile, callerId, fileNode }) => {
    if (!fileNode.isTest) return;
    for (const literal of stringLiteralValues(sourceFile)) {
      for (const route of routes) {
        if (route.match.test(literal)) {
          addRouteEdgeOnce(graph, callerId, route.fileId);
        }
      }
    }
  });
}
