import fs from "node:fs/promises";
import path from "node:path";

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
    const buffer = await fs.readFile(filePath);
    return new Response(buffer, {
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
