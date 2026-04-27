import { deleteRecipe, getRecipe, updateRecipe } from "../../../../lib/recipes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = {
  params: Promise<{ id: string }>;
};

async function recipeId(context: Context): Promise<number> {
  const params = await context.params;
  return Number(params.id);
}

export async function GET(_request: Request, context: Context) {
  const recipe = getRecipe(await recipeId(context));
  if (!recipe) return Response.json({ error: "Recipe not found." }, { status: 404 });
  return Response.json({ recipe });
}

export async function PATCH(request: Request, context: Context) {
  const body = await request.json().catch(() => null);
  const recipe = updateRecipe(await recipeId(context), body ?? {});
  if (!recipe) return Response.json({ error: "Recipe not found." }, { status: 404 });
  return Response.json({ recipe });
}

export async function DELETE(_request: Request, context: Context) {
  const deleted = deleteRecipe(await recipeId(context));
  if (!deleted) return Response.json({ error: "Recipe not found." }, { status: 404 });
  return Response.json({ ok: true });
}
