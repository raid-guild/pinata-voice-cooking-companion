import { handleAudioQuery, handleNextStep } from "../../lib/audio-query";
import { fallbackSessionId, sessionIdFromFormRequest, sessionIdFromJsonRequest } from "../../lib/request-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";

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

    try {
      const result = await handleNextStep(sessionId, { includeAudio: true });
      return Response.json(result, { status: result.ok ? 200 : 400 });
    } catch (error) {
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

  if (!contentType.includes("multipart/form-data")) {
    const sessionId = fallbackSessionId();
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

  let sessionId = fallbackSessionId();
  try {
    const formData = await request.formData();
    sessionId = sessionIdFromFormRequest(request, formData);
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
      sessionId
    });

    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
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
