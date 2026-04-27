import { randomUUID } from "node:crypto";
import { handleNextStep, handleTextQuery } from "../../lib/audio-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type InputMode = "query" | "next_step";

function sessionIdFromRequest(request: Request, body: Record<string, unknown> | null): string {
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

  return `sess_${randomUUID()}`;
}

function publicBaseUrlFromRequest(request: Request): string | undefined {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  if (forwardedProto && forwardedHost) return `${forwardedProto}://${forwardedHost}`;

  const host = request.headers.get("host")?.trim();
  if (host && !["0.0.0.0:3000", "127.0.0.1:3000", "localhost:3000"].includes(host)) {
    return `${forwardedProto || "https"}://${host}`;
  }

  return undefined;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const inputMode = body?.inputMode as InputMode | undefined;
  const sessionId = sessionIdFromRequest(request, body);
  const publicBaseUrl = publicBaseUrlFromRequest(request);

  if (inputMode !== "query" && inputMode !== "next_step") {
    return Response.json(
      {
        ok: false,
        answerText: 'Provide inputMode as "query" or "next_step".',
        session: {
          id: sessionId,
          activeRecipeId: null,
          stepIndex: 0,
          phase: "ingredients"
        }
      },
      { status: 400 }
    );
  }

  if (inputMode === "query" && !(typeof body?.query === "string" && body.query.trim())) {
    return Response.json(
      {
        ok: false,
        answerText: 'Provide query text in the query field when inputMode is "query".',
        session: {
          id: sessionId,
          activeRecipeId: null,
          stepIndex: 0,
          phase: "ingredients"
        }
      },
      { status: 400 }
    );
  }

  try {
    const result =
      inputMode === "next_step"
        ? await handleNextStep(sessionId, { includeAudio: false, publicBaseUrl })
        : await handleTextQuery({
            transcript: body?.query as string,
            publicBaseUrl,
            sessionId,
            includeAudio: false
          });

    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch {
    return Response.json(
      {
        ok: false,
        answerText: "Sorry, I couldn’t process that request.",
        session: {
          id: sessionId,
          activeRecipeId: null,
          stepIndex: 0,
          phase: "ingredients"
        }
      },
      { status: 500 }
    );
  }
}
