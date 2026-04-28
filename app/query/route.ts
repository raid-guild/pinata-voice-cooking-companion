import { handleNextStep, handleTextQuery } from "../../lib/audio-query";
import { fallbackSessionId, sessionIdFromJsonRequest } from "../../lib/request-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type InputMode = "query" | "next_step";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const inputMode = body?.inputMode as InputMode | undefined;
  const sessionId = sessionIdFromJsonRequest(request, body);

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
    const cleanedTranscript = typeof body?.query === "string" ? body.query.trim() : "";
    const result =
      inputMode === "next_step"
        ? await handleNextStep(sessionId, { includeAudio: false, transcript: cleanedTranscript })
        : await handleTextQuery({
            transcript: body?.query as string,
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
          id: sessionId || fallbackSessionId(),
          activeRecipeId: null,
          stepIndex: 0,
          phase: "ingredients"
        }
      },
      { status: 500 }
    );
  }
}
