// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC over POST, speaking the modern
// server/discover revision (with the legacy initialize handshake answered too), and six tools
// that operate on the same forge state as REST and GraphQL.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, Repo } from './forge.ts';

const SERVER_INFO = { name: 'mini-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: 'owner,repo'.split(','),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolOk(payload: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolErr(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve the repository a tool call names, learning the owner login on first contact. */
function toolRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== '') forge.learnLogin(owner);
  if (forge.login !== null && owner !== forge.login) return null;
  return forge.repoByName(name) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { rpc: unknown } | { error: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of tool.required) {
    const value = args[required];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = forge.repoByName(repoName);
      if (existing) return { rpc: toolOk(repoJson(forge, existing)) };
      const repo = forge.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { rpc: toolOk(repoJson(forge, repo)) };
    }
    case 'get_repo': {
      const repo = toolRepo(forge, args);
      if (!repo) return { rpc: toolErr('Repository not found') };
      return { rpc: toolOk(repoJson(forge, repo)) };
    }
    case 'create_issue': {
      const repo = toolRepo(forge, args);
      if (!repo) return { rpc: toolErr('Repository not found') };
      const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { rpc: toolOk(issueJson(forge, repo, issue)) };
    }
    case 'list_issues': {
      const repo = toolRepo(forge, args);
      if (!repo) return { rpc: toolErr('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'all';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return { rpc: toolOk({ issues }) };
    }
    case 'create_pull_request': {
      const repo = toolRepo(forge, args);
      if (!repo) return { rpc: toolErr('Repository not found') };
      const head = String(args.head);
      const base = String(args.base);
      const headTip = forge.branchTip(repo, head);
      const baseTip = forge.branchTip(repo, base);
      if (headTip === null || baseTip === null) return { rpc: toolErr('The head or base branch does not exist') };
      if (headTip === baseTip) return { rpc: toolErr('No commits between the base and the head') };
      const pull = forge.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return { rpc: toolOk(pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = toolRepo(forge, args);
      if (!repo) return { rpc: toolErr('Repository not found') };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { rpc: toolErr('Pull request not found') };
      if (pull.state !== 'open') return { rpc: toolErr('Pull request is not open') };
      const sha = forge.mergePull(repo, pull, 'merge');
      if (sha === null) return { rpc: toolErr('Pull request is not mergeable') };
      return { rpc: toolOk(pullJson(forge, repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Handle one POST /mcp body. Auth is enforced by the caller before this runs. */
export function handleMcp(forge: Forge, rawBody: Buffer): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return { status: 400, body: rpcError(isRecord(parsed) ? parsed.id : null, -32600, 'Invalid Request') };
  }
  const id = parsed.id;
  const params = isRecord(parsed.params) ? parsed.params : {};
  if (id === undefined) {
    // A notification: accepted, never answered.
    return { status: 202, body: '' };
  }
  switch (parsed.method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, toolsListResult()) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(forge, toolName, toolArgs);
      if ('error' in outcome) return { status: 200, body: rpcError(id, outcome.error.code, outcome.error.message) };
      return { status: 200, body: rpcResult(id, outcome.rpc) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${parsed.method}`) };
  }
}
