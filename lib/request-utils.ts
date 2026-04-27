import { randomUUID } from "node:crypto";

export function fallbackSessionId(): string {
  return `sess_${randomUUID()}`;
}

export function sessionIdFromJsonRequest(request: Request, body: Record<string, unknown> | null): string {
  const fromBody = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (fromBody) return fromBody;

  const nestedSession = body?.session;
  const fromNested =
    nestedSession && typeof nestedSession === "object" && typeof (nestedSession as { id?: unknown }).id === "string"
      ? ((nestedSession as { id: string }).id || "").trim()
      : "";
  if (fromNested) return fromNested;

  const fromHeader = request.headers.get("x-session-id")?.trim();
  if (fromHeader) return fromHeader;

  return fallbackSessionId();
}

export function sessionIdFromFormRequest(request: Request, formData: FormData): string {
  const fromBody = formData.get("sessionId");
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();

  const nestedSessionId = formData.get("session.id");
  if (typeof nestedSessionId === "string" && nestedSessionId.trim()) return nestedSessionId.trim();

  const fromHeader = request.headers.get("x-session-id");
  if (fromHeader?.trim()) return fromHeader.trim();

  return fallbackSessionId();
}
