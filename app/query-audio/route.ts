import { handleAudioQuery, handleNextStep } from "../../lib/audio-query";
import { fallbackSessionId, sessionIdFromFormRequest, sessionIdFromJsonRequest } from "../../lib/request-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function summarizeAudioError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("openai_api_key")) return "Audio processing is not configured yet.";
  if (lower.includes("audio file is too short") || lower.includes("audio_too_short")) {
    return "That recording was too short. Hold the button a little longer, then try again.";
  }
  if (lower.includes("could not be decoded") || lower.includes("format is not supported")) {
    return "That audio recording couldn’t be decoded. Please try again.";
  }
  if (lower.includes("too large") || lower.includes("payload too large")) {
    return "That audio file is too large.";
  }
  return "Sorry, I couldn’t process that audio request.";
}

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
      console.error("[query-audio] JSON next_step request failed", error);
      const message = error instanceof Error ? error.message : "Unknown error.";
      return Response.json(
        {
          ok: false,
          answerText: summarizeAudioError(message),
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

    if (process.env.DEBUG_AUDIO_QUERY === "1") {
      console.log("[query-audio] received audio upload", {
        type: audioInput.type,
        size: audioInput.size
      });
    }

    const result = await handleAudioQuery({
      file: audioInput,
      sessionId
    });

    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    console.error("[query-audio] Multipart audio request failed", error);
    const message = error instanceof Error ? error.message : "Unknown error.";
    return Response.json(
      {
        ok: false,
        answerText: summarizeAudioError(message),
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
