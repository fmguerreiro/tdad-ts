export type NodeKind = "File" | "Function" | "Class" | "Test";
export type EdgeKind =
  | "CONTAINS"
  | "CALLS"
  | "IMPORTS"
  | "INHERITS"
  | "TESTS";

export interface FileNode {
  kind: "File";
  id: string;
  path: string;
  contentHash: string;
  isTest: boolean;
}

export interface FunctionNode {
  kind: "Function";
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface ClassNode {
  kind: "Class";
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface TestNode {
  kind: "Test";
  id: string;
  name: string;
  file: string;
}

export type GraphNode = FileNode | FunctionNode | ClassNode | TestNode;

export interface Edge {
  kind: EdgeKind;
  from: string;
  to: string;
}

export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edgesOut = new Map<string, Edge[]>();
  readonly edgesIn = new Map<string, Edge[]>();

  addNode(node: GraphNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    this.nodes.set(node.id, node);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node id: ${id}`);
    return node;
  }

  addEdge(edge: Edge): void {
    if (!this.nodes.has(edge.from)) {
      throw new Error(`edge ${edge.kind} from missing node ${edge.from}`);
    }
    if (!this.nodes.has(edge.to)) {
      throw new Error(`edge ${edge.kind} to missing node ${edge.to}`);
    }
    push(this.edgesOut, edge.from, edge);
    push(this.edgesIn, edge.to, edge);
  }

  outgoing(id: string, kind?: EdgeKind): Edge[] {
    const edges = this.edgesOut.get(id) ?? [];
    return kind ? edges.filter((edge) => edge.kind === kind) : edges;
  }

  incoming(id: string, kind?: EdgeKind): Edge[] {
    const edges = this.edgesIn.get(id) ?? [];
    return kind ? edges.filter((edge) => edge.kind === kind) : edges;
  }

  files(): FileNode[] {
    const files: FileNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === "File") files.push(node);
    }
    return files;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
