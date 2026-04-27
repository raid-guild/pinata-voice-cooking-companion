import { createFoodEvent, listFoodEvents, seedFoodEvents, seedRecipes } from "../../../lib/recipes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  seedRecipes();
  seedFoodEvents();
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  return Response.json({ events: listFoodEvents(limit) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";

  if (!title) {
    return Response.json({ error: "Title is required." }, { status: 400 });
  }

  const event = createFoodEvent(body);
  return Response.json({ event }, { status: 201 });
}
