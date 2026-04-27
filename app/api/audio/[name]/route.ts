import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const generatedAudioDir = path.join(process.cwd(), "workspace", "generated-audio");

type Context = {
  params: Promise<{ name: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { name } = await context.params;
  const safeName = path.basename(name);
  const filePath = path.join(generatedAudioDir, safeName);

  try {
    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=3600"
      }
    });
  } catch {
    return Response.json({ error: "Audio not found." }, { status: 404 });
  }
}
