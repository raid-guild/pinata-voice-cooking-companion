import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type ChefPersonality =
  | "ransom"
  | "julienne"
  | "bordo"
  | "blaze"
  | "brownstone"
  | "stewart"
  | "rosa";

export type RecipeInput = {
  title: string;
  sourceUrl?: string;
  imageUrl?: string;
  description?: string;
  ingredients?: string[];
  instructions?: string[];
  tags?: string[];
  effort?: string;
  theme?: string;
  notes?: string;
};

export type Recipe = Required<Omit<RecipeInput, "sourceUrl" | "imageUrl" | "description" | "effort" | "theme" | "notes">> & {
  id: number;
  sourceUrl: string;
  imageUrl: string;
  description: string;
  effort: string;
  theme: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type FoodEventInput = {
  title: string;
  body?: string;
  kind?: "note" | "cooked" | "plan" | "suggestion";
  recipeId?: number | null;
};

export type FoodEvent = {
  id: number;
  title: string;
  body: string;
  kind: "note" | "cooked" | "plan" | "suggestion";
  recipeId: number | null;
  recipeTitle: string;
  createdAt: string;
};

export type VoicePendingPrompt = "ingredients_or_first_step" | "ingredients_or_repeat" | null;
export type VoicePhase = "ingredients" | "steps";

export type VoiceSessionState = {
  activeRecipeId: string | null;
  stepIndex: number;
  phase: VoicePhase;
  pendingPrompt: VoicePendingPrompt;
};

const dataDir = path.join(process.cwd(), "workspace", "data");
const dbPath = path.join(dataDir, "recipes.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_url TEXT,
    image_url TEXT,
    description TEXT,
    ingredients TEXT NOT NULL DEFAULT '[]',
    instructions TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    effort TEXT,
    theme TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS food_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    kind TEXT NOT NULL DEFAULT 'note',
    recipe_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS voice_sessions (
    client_key TEXT PRIMARY KEY,
    active_recipe_id TEXT,
    step_index INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'ingredients',
    pending_prompt TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

try {
  db.exec("ALTER TABLE voice_sessions ADD COLUMN pending_prompt TEXT");
} catch {
  // Column already exists on upgraded databases.
}

try {
  db.exec("ALTER TABLE voice_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'ingredients'");
} catch {
  // Column already exists on upgraded databases.
}

type RecipeRow = {
  id: number;
  title: string;
  source_url: string | null;
  image_url: string | null;
  description: string | null;
  ingredients: string;
  instructions: string;
  tags: string;
  effort: string | null;
  theme: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type FoodEventRow = {
  id: number;
  title: string;
  body: string | null;
  kind: string;
  recipe_id: number | null;
  recipe_title: string | null;
  created_at: string;
};

type VoiceSessionRow = {
  client_key: string;
  active_recipe_id: string | null;
  step_index: number;
  phase: VoicePhase | null;
  pending_prompt: VoicePendingPrompt;
};

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url ?? "",
    imageUrl: row.image_url ?? "",
    description: row.description ?? "",
    ingredients: parseList(row.ingredients),
    instructions: parseList(row.instructions),
    tags: parseList(row.tags),
    effort: row.effort ?? "",
    theme: row.theme ?? "",
    notes: row.notes ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeEventKind(value: unknown): FoodEvent["kind"] {
  return value === "cooked" || value === "plan" || value === "suggestion" ? value : "note";
}

function mapFoodEvent(row: FoodEventRow): FoodEvent {
  return {
    id: row.id,
    title: row.title,
    body: row.body ?? "",
    kind: normalizeEventKind(row.kind),
    recipeId: row.recipe_id,
    recipeTitle: row.recipe_title ?? "",
    createdAt: row.created_at
  };
}

function normalizeList(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function mapVoiceSession(row?: VoiceSessionRow): VoiceSessionState {
  return {
    activeRecipeId: row?.active_recipe_id ?? null,
    stepIndex: row?.step_index ?? 0,
    phase: row?.phase === "steps" ? "steps" : "ingredients",
    pendingPrompt: row?.pending_prompt ?? null
  };
}

export function listRecipes(query = ""): Recipe[] {
  const search = query.trim();
  if (!search) {
    const rows = db
      .prepare("SELECT * FROM recipes ORDER BY updated_at DESC, id DESC")
      .all() as RecipeRow[];
    return rows.map(mapRecipe);
  }

  const like = `%${search}%`;
  const rows = db
    .prepare(
      `SELECT * FROM recipes
       WHERE title LIKE @like
          OR description LIKE @like
          OR ingredients LIKE @like
          OR tags LIKE @like
          OR effort LIKE @like
          OR theme LIKE @like
          OR notes LIKE @like
       ORDER BY updated_at DESC, id DESC`
    )
    .all({ like }) as RecipeRow[];
  return rows.map(mapRecipe);
}

export function getRecipe(id: number): Recipe | null {
  const row = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | undefined;
  return row ? mapRecipe(row) : null;
}

export function createRecipe(input: RecipeInput): Recipe {
  const title = input.title.trim();
  if (!title) throw new Error("Title is required.");

  const result = db
    .prepare(
      `INSERT INTO recipes (
        title, source_url, image_url, description, ingredients, instructions, tags, effort, theme, notes
      ) VALUES (
        @title, @sourceUrl, @imageUrl, @description, @ingredients, @instructions, @tags, @effort, @theme, @notes
      )`
    )
    .run({
      title,
      sourceUrl: input.sourceUrl?.trim() || "",
      imageUrl: input.imageUrl?.trim() || "",
      description: input.description?.trim() || "",
      ingredients: JSON.stringify(normalizeList(input.ingredients)),
      instructions: JSON.stringify(normalizeList(input.instructions)),
      tags: JSON.stringify(normalizeList(input.tags)),
      effort: input.effort?.trim() || "",
      theme: input.theme?.trim() || "",
      notes: input.notes?.trim() || ""
    });

  return getRecipe(Number(result.lastInsertRowid)) as Recipe;
}

export function updateRecipe(id: number, input: Partial<RecipeInput>): Recipe | null {
  const current = getRecipe(id);
  if (!current) return null;

  const next = {
    title: input.title?.trim() || current.title,
    sourceUrl: input.sourceUrl?.trim() ?? current.sourceUrl,
    imageUrl: input.imageUrl?.trim() ?? current.imageUrl,
    description: input.description?.trim() ?? current.description,
    ingredients: JSON.stringify(input.ingredients ? normalizeList(input.ingredients) : current.ingredients),
    instructions: JSON.stringify(input.instructions ? normalizeList(input.instructions) : current.instructions),
    tags: JSON.stringify(input.tags ? normalizeList(input.tags) : current.tags),
    effort: input.effort?.trim() ?? current.effort,
    theme: input.theme?.trim() ?? current.theme,
    notes: input.notes?.trim() ?? current.notes,
    id
  };

  db.prepare(
    `UPDATE recipes
     SET title = @title,
         source_url = @sourceUrl,
         image_url = @imageUrl,
         description = @description,
         ingredients = @ingredients,
         instructions = @instructions,
         tags = @tags,
         effort = @effort,
         theme = @theme,
         notes = @notes,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ).run(next);

  return getRecipe(id);
}

export function deleteRecipe(id: number): boolean {
  const result = db.prepare("DELETE FROM recipes WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listFoodEvents(limit = 25): FoodEvent[] {
  const rows = db
    .prepare(
      `SELECT food_events.*, recipes.title AS recipe_title
       FROM food_events
       LEFT JOIN recipes ON recipes.id = food_events.recipe_id
       ORDER BY food_events.created_at DESC, food_events.id DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 100)) as FoodEventRow[];
  return rows.map(mapFoodEvent);
}

export function createFoodEvent(input: FoodEventInput): FoodEvent {
  const title = input.title.trim();
  if (!title) throw new Error("Title is required.");

  const result = db
    .prepare(
      `INSERT INTO food_events (title, body, kind, recipe_id)
       VALUES (@title, @body, @kind, @recipeId)`
    )
    .run({
      title,
      body: input.body?.trim() || "",
      kind: normalizeEventKind(input.kind),
      recipeId: input.recipeId ?? null
    });

  return listFoodEvents(100).find((event) => event.id === Number(result.lastInsertRowid)) as FoodEvent;
}

export function getVoiceSession(clientKey: string): VoiceSessionState {
  const row = db
    .prepare("SELECT client_key, active_recipe_id, step_index, phase, pending_prompt FROM voice_sessions WHERE client_key = ?")
    .get(clientKey) as VoiceSessionRow | undefined;
  return mapVoiceSession(row);
}

export function setVoiceSession(clientKey: string, input: VoiceSessionState): VoiceSessionState {
  db.prepare(
    `INSERT INTO voice_sessions (client_key, active_recipe_id, step_index, phase, pending_prompt, updated_at)
     VALUES (@clientKey, @activeRecipeId, @stepIndex, @phase, @pendingPrompt, CURRENT_TIMESTAMP)
     ON CONFLICT(client_key) DO UPDATE SET
       active_recipe_id = excluded.active_recipe_id,
       step_index = excluded.step_index,
       phase = excluded.phase,
       pending_prompt = excluded.pending_prompt,
       updated_at = CURRENT_TIMESTAMP`
  ).run({
    clientKey,
    activeRecipeId: input.activeRecipeId,
    stepIndex: Math.max(0, Math.floor(input.stepIndex || 0)),
    phase: input.phase === "steps" ? "steps" : "ingredients",
    pendingPrompt: input.pendingPrompt ?? null
  });

  return getVoiceSession(clientKey);
}

export function seedRecipes(): Recipe[] {
  if (listRecipes().length > 0) {
    seedFoodEvents();
    return listRecipes();
  }

  const recipe = createRecipe({
    title: "Weeknight Lemon Garlic Pasta",
    description: "A fast pantry dinner with bright lemon, garlic, butter, and parmesan.",
    ingredients: ["spaghetti", "garlic", "lemon", "butter", "parmesan", "parsley"],
    instructions: ["Boil pasta until al dente.", "Sizzle garlic in butter.", "Toss pasta with lemon juice, zest, parmesan, and pasta water.", "Finish with parsley and black pepper."],
    tags: ["weeknight", "vegetarian", "pantry"],
    effort: "easy",
    theme: "comfort",
    notes: "Good candidate for shrimp, broccolini, or chili crisp pivots."
  });

  seedFoodEvents(recipe.id);
  return listRecipes();
}

export function seedFoodEvents(recipeId?: number): FoodEvent[] {
  if (listFoodEvents(1).length > 0) return listFoodEvents();

  createFoodEvent({
    title: "Used lemon garlic pasta for dinner",
    body: "Today I used the lemon garlic recipe for dinner. Next time, add more lemon zest and reserve extra pasta water.",
    kind: "cooked",
    recipeId: recipeId ?? listRecipes()[0]?.id ?? null
  });

  createFoodEvent({
    title: "Weekly dinner plan suggestion",
    body: "Plan around one quick pasta night, one soup or stew, one leftovers remix, and one low-effort protein with salad.",
    kind: "plan"
  });

  return listFoodEvents();
}
