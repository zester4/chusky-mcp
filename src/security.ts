export type McpIdentity = { apiKey: string; userId: string; scopes?: readonly string[] };

export function allowedApiPath(path: string): boolean {
  return path.startsWith("/v1/") && !path.startsWith("//") && !path.includes("\\");
}

export function configuredApiOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((!local && url.protocol !== "https:") || (local && !["http:", "https:"].includes(url.protocol))) return undefined;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function requestIdentity(request: Request): McpIdentity | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(chsk_[A-Za-z0-9_-]{16,500})$/.exec(authorization);
  const userId = (request.headers.get("x-chusky-user-id") ?? "").trim();
  if (!match || !userId || userId.length > 200 || /[\u0000-\u001f\u007f]/.test(userId)) return undefined;
  return { apiKey: match[1]!, userId };
}

export function hasMcpScope(identity: McpIdentity, scope: string): boolean {
  if (identity.scopes === undefined || identity.scopes.includes(scope)) return true;
  if (scope === "mcp:read") return identity.scopes.includes("mcp:run") || identity.scopes.includes("mcp:manage") || identity.scopes.includes("mcp:company");
  if (scope === "mcp:run") return identity.scopes.includes("mcp:manage");
  return false;
}

export function requireMcpScope(identity: McpIdentity, scope: string): void {
  if (!hasMcpScope(identity, scope)) {
    throw new Error(`This MCP authorization requires the '${scope}' scope.`);
  }
}
