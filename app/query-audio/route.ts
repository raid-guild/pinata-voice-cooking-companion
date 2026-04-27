import { randomUUID } from "node:crypto";
import { handleAudioQuery, handleNextStep } from "../../lib/audio-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sessionIdFromFormRequest(request: Request, formData: FormData): string {
  const fromBody = formData.get("sessionId");
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();

  const nestedSessionId = formData.get("session.id");
  if (typeof nestedSessionId === "string" && nestedSessionId.trim()) return nestedSessionId.trim();

  const fromHeader = request.headers.get("x-session-id");
  if (fromHeader?.trim()) return fromHeader.trim();

  return `sess_${randomUUID()}`;
}

function sessionIdFromJsonRequest(request: Request, body: Record<string, unknown> | null): string {
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
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const host = request.headers.get("host")?.trim();
  if (host && !["0.0.0.0:3000", "127.0.0.1:3000", "localhost:3000"].includes(host)) {
    const proto = forwardedProto || "https";
    return `${proto}://${host}`;
  }

  return undefined;
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  const publicBaseUrl = publicBaseUrlFromRequest(request);

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const inputMode = body?.inputMode;
    const sessionId = sessionIdFromJsonRequest(request, body);

    if (inputMode !== "next_step") {
      return Response.json(
        {
          ok: false,
          answerText: 'For JSON requests, provide inputMode as "next_step".',
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

    const result = await handleNextStep(sessionId, { includeAudio: true, publicBaseUrl });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  if (!contentType.includes("multipart/form-data")) {
    const sessionId = `sess_${randomUUID()}`;
    return Response.json(
      {
        ok: false,
        answerText: 'Send multipart audio for spoken queries, or JSON with inputMode="next_step" for button advancement.',
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
    const formData = await request.formData();
    const sessionId = sessionIdFromFormRequest(request, formData);
    const audioInput = formData.get("audio") ?? formData.get("file");

    if (!(audioInput instanceof File)) {
      return Response.json(
        {
          ok: false,
          answerText: "Attach an audio file in the audio field.",
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

    const result = await handleAudioQuery({
      file: audioInput,
      publicBaseUrl,
      sessionId
    });

    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    const sessionId = `sess_${randomUUID()}`;
    const message = error instanceof Error ? error.message : "Unknown error.";
    return Response.json(
      {
        ok: false,
        answerText: message.includes("OPENAI_API_KEY")
          ? "Audio processing is not configured yet."
          : "Sorry, I couldn’t process that audio request.",
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
