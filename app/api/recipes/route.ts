import { createRecipe, listRecipes, seedRecipes } from "../../../lib/recipes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  seedRecipes();
  const url = new URL(request.url);
  return Response.json({ recipes: listRecipes(url.searchParams.get("q") ?? "") });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";

  if (!title) {
    return Response.json({ error: "Title is required." }, { status: 400 });
  }

  const recipe = createRecipe(body);
  return Response.json({ recipe }, { status: 201 });
}
