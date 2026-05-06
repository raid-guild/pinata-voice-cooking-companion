import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listRecipes, type Recipe, getVoiceSession, setVoiceSession, type VoiceSessionState } from "./recipes";

export type AudioIntent =
  | "recipe_lookup"
  | "load_recipe"
  | "next_step"
  | "substitution_question"
  | "repeat_step"
  | "general_help";

export type QueryResult = {
  ok: boolean;
  transcript?: string;
  intent?: AudioIntent;
  answerText: string;
  audio?: {
    mimeType: string;
    url: string;
  };
  session?: {
    id: string;
    activeRecipeId: string | null;
    stepIndex: number;
    phase: "ingredients" | "steps";
  };
};

type ModelAction =
  | "search_recipe"
  | "load_recipe"
  | "get_ingredients"
  | "get_current_step"
  | "next_step"
  | "previous_step"
  | "repeat_step"
  | "substitution_question"
  | "recipe_question"
  | "clarify"
  | "general_help";

type ModelQuestionType = "time" | "temperature" | "step_number" | "ingredient_amount" | "ingredient_identity" | "other";

type ParsedQuery = {
  action: ModelAction;
  recipeTitle?: string;
  recipeId?: number;
  ingredient?: string;
  question?: string;
  questionType?: ModelQuestionType;
  answerStyle?: "ingredients" | "first_step" | "auto";
  confidence?: number;
};

const generatedAudioDir = path.join(process.cwd(), "workspace", "generated-audio");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const QUERY_MODEL = process.env.OPENAI_QUERY_MODEL || "gpt-4.1-nano";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const FILLER_WORDS = new Set(["please", "the", "a", "an", "me", "just", "now", "okay", "ok"]);
const QUERY_STOP_WORDS = new Set([
  "what",
  "whats",
  "good",
  "could",
  "should",
  "would",
  "recipe",
  "recipes",
  "make",
  "cook",
  "try",
  "with",
  "want",
  "need",
  "load",
  "open",
  "start",
  "for",
  "something",
  "similar"
]);
const PROTEIN_WORDS = new Set(["chicken", "tuna", "salmon", "shrimp", "tofu", "egg", "eggs", "turkey", "fish"]);
const DISH_TYPE_WORDS = new Set([
  "burger",
  "sandwich",
  "ramen",
  "pasta",
  "noodles",
  "casserole",
  "soup",
  "stew",
  "salad",
  "rice",
  "bowl",
  "wrap",
  "tacos",
  "taco"
]);

function isSupportedAudioFile(file: File): boolean {
  const normalizedType = file.type.split(";")[0]?.trim().toLowerCase() || "";
  if (["audio/wav", "audio/mpeg", "audio/webm", "audio/ogg"].includes(normalizedType)) return true;
  const lowerName = file.name.toLowerCase();
  return lowerName.endsWith(".wav") || lowerName.endsWith(".mp3") || lowerName.endsWith(".webm") || lowerName.endsWith(".ogg");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function words(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter(Boolean)
    .filter((word) => !FILLER_WORDS.has(word));
}

function hasAllWords(text: string, required: string[]): boolean {
  const tokenSet = new Set(words(text));
  return required.every((word) => tokenSet.has(word));
}

function recipeTokenVariants(title: string): string[] {
  const normalized = normalize(title);
  const variants = new Set([normalized]);
  variants.add(normalized.replace(/\b(recipe|the|a|an)\b/g, " ").replace(/\s+/g, " ").trim());
  return [...variants].filter(Boolean);
}

function buildSessionRecipeId(recipe: Recipe): string {
  return `${slugify(recipe.title) || "recipe"}-${recipe.id}`;
}

function findRecipeBySessionId(activeRecipeId: string | null): Recipe | null {
  if (!activeRecipeId) return null;
  return listRecipes().find((recipe) => buildSessionRecipeId(recipe) === activeRecipeId) ?? null;
}

function findRecipeFromTranscript(transcript: string): Recipe | null {
  const text = normalize(transcript);
  let best: { recipe: Recipe; score: number } | null = null;

  for (const recipe of listRecipes()) {
    for (const variant of recipeTokenVariants(recipe.title)) {
      let score = 0;
      if (text === variant) score = 100;
      else if (text.includes(` ${variant} `) || text.startsWith(`${variant} `) || text.endsWith(` ${variant}`)) score = 90;
      else if (text.includes(variant)) score = 75;
      else {
        const titleWords = variant.split(" ").filter((word) => word.length > 2);
        const matchedWords = titleWords.filter((word) => text.includes(word)).length;
        if (titleWords.length > 0) {
          const ratio = matchedWords / titleWords.length;
          if (ratio >= 0.8) score = 60;
          else if (ratio >= 0.5) score = 45;
        }
      }
      if (!best || score > best.score) best = { recipe, score };
    }
  }

  return best && best.score >= 45 ? best.recipe : null;
}

function recommendRecipeFromTranscript(transcript: string): Recipe | null {
  const queryWords = Array.from(new Set(words(transcript).filter((word) => !QUERY_STOP_WORDS.has(word))));

  if (queryWords.length === 0) return null;

  let best: { recipe: Recipe; score: number } | null = null;
  for (const recipe of listRecipes()) {
    const normalizedTitle = normalize(recipe.title);
    const haystack = normalize([recipe.title, recipe.description, recipe.theme, recipe.effort, ...recipe.tags, ...recipe.ingredients].join(" "));
    let score = 0;

    for (const word of queryWords) {
      const inTitle = normalizedTitle.includes(word);
      const inHaystack = haystack.includes(word);
      if (!inHaystack) continue;

      score += inTitle ? 5 : word.length >= 5 ? 3 : 2;

      if (PROTEIN_WORDS.has(word) && inHaystack) score += 4;
      if (DISH_TYPE_WORDS.has(word) && inTitle) score += 6;
      else if (DISH_TYPE_WORDS.has(word) && inHaystack) score += 3;
    }

    const proteinMatches = queryWords.filter((word) => PROTEIN_WORDS.has(word) && haystack.includes(word)).length;
    const dishTypeMatches = queryWords.filter((word) => DISH_TYPE_WORDS.has(word) && haystack.includes(word)).length;
    if (proteinMatches > 0) score += proteinMatches * 3;
    if (dishTypeMatches > 0) score += dishTypeMatches * 4;

    if (!best || score > best.score) best = { recipe, score };
  }

  return best && best.score > 0 ? best.recipe : null;
}

function detectIntent(transcript: string, resolvedRecipe: Recipe | null): AudioIntent {
  const text = normalize(transcript);
  const soundsLikeRecipe = /\b(how do i make|how to make|recipe for|make|cook|i want to cook|i want to make)\b/.test(text);

  if (/\b(next|next step|what s next|what is next|continue|go on|advance)\b/.test(text)) return "next_step";
  if (/\b(repeat|again|say that again|repeat that)\b/.test(text)) return "repeat_step";
  if (/\b(substitute|substitution|replace|swap|instead|can i use)\b/.test(text)) return "substitution_question";
  if (/\b(load|open|start)\b/.test(text) && resolvedRecipe) return "load_recipe";
  if (soundsLikeRecipe && resolvedRecipe) return "recipe_lookup";
  return "general_help";
}

function soundsLikeRecipeRequest(transcript: string): boolean {
  const text = normalize(transcript);
  return /\b(recipe|make|cook|how do i make|how to make|load|open|start)\b/.test(text);
}

function extractRecipeRequestLabel(transcript: string): string {
  const text = transcript.trim();
  return text
    .replace(/^(i want to cook|i want to make|how do i make|how to make|recipe for|load|open|start)\s+/i, "")
    .replace(/[?!.]+$/, "")
    .replace(/\brecipe\b$/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .trim() || "that recipe";
}

function missingRecipeAnswer(requestedTitle: string, transcript: string, currentRecipe: Recipe | null): string {
  const similarRecipe = recommendRecipeFromTranscript(transcript);
  const similarText = similarRecipe ? ` A similar saved recipe is ${similarRecipe.title}.` : "";
  const currentRecipeText = currentRecipe ? ` Your current recipe is still ${currentRecipe.title}.` : "";
  return `I don’t have a saved recipe for ${requestedTitle} yet.${similarText}${currentRecipeText}`;
}

function logQueryDecision(event: string, details: Record<string, unknown>) {
  if (process.env.DEBUG_AUDIO_QUERY !== "1") return;
  const redactedDetails = {
    ...details,
    transcript: typeof details.transcript === "string" ? `${details.transcript.slice(0, 120)}${details.transcript.length > 120 ? "…" : ""}` : details.transcript
  };
  try {
    console.log(`[audio-query] ${event} ${JSON.stringify(redactedDetails)}`);
  } catch {
    console.log(`[audio-query] ${event}`);
  }
}

function spokenStep(recipe: Recipe, index: number): string | null {
  const step = recipe.instructions[index]?.trim();
  return step ? `Step ${index + 1}. ${step}` : null;
}

function summarizeIngredients(recipe: Recipe): string {
  const items = recipe.ingredients.filter(Boolean);
  if (items.length === 0) return `I have ${recipe.title}, but the ingredient list is empty.`;
  const shortList = items.slice(0, 8).join(", ");
  return items.length > 8 ? `Ingredients for ${recipe.title}: ${shortList}, and more.` : `Ingredients for ${recipe.title}: ${shortList}.`;
}

function isAffirmative(text: string): boolean {
  return ["yes", "yeah", "yep", "sure", "okay", "ok", "go ahead", "do it"].includes(normalize(text));
}

function isIngredientRequest(text: string): boolean {
  const normalized = normalize(text);
  if (/\b(which ingredient|what ingredient|quantity|amount)\b/.test(normalized)) return false;
  if (/\b(how much|how many)\b/.test(normalized) && /\bingredient\b/.test(normalized) && !/\bingredients\b/.test(normalized)) return false;
  const tokenSet = new Set(words(text));
  return tokenSet.has("ingredients") || tokenSet.has("ingredient");
}

function isFirstStepRequest(text: string): boolean {
  return hasAllWords(text, ["first", "step"]) || hasAllWords(text, ["step", "one"]) || hasAllWords(text, ["start", "cooking"]) || normalize(text) === "start";
}

function isRepeatRequest(text: string): boolean {
  const normalized = normalize(text);
  return normalized.includes("repeat") || normalized.includes("again");
}

function isWhereAmIRequest(text: string): boolean {
  return /\b(where am i|where are we|what step am i on|what ingredient am i on|which ingredient am i on)\b/.test(normalize(text));
}

function isStartOverRequest(text: string): boolean {
  return /\b(start over|from the top|begin again|restart)\b/.test(normalize(text));
}

function isNextIngredientRequest(text: string): boolean {
  return /\b(next ingredient|what s the next ingredient|what is the next ingredient)\b/.test(normalize(text));
}

function isPreviousIngredientRequest(text: string): boolean {
  return /\b(previous ingredient|last ingredient|ingredient before|go back an ingredient)\b/.test(normalize(text));
}

function extractRequestedStepIndex(text: string): number | null {
  const normalized = normalize(text);
  const match = normalized.match(/\b(?:go to|jump to|take me to|read|show me)?\s*step\s+(\d{1,3})\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : null;
}

function extractRequestedIngredientIndex(text: string): number | null {
  const normalized = normalize(text);
  const match = normalized.match(/\b(?:go to|jump to|take me to|read|show me)?\s*ingredient\s+(\d{1,3})\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : null;
}

function sessionPayload(sessionId: string, state: VoiceSessionState) {
  return {
    id: sessionId,
    activeRecipeId: state.activeRecipeId,
    stepIndex: state.stepIndex,
    phase: state.phase
  };
}

function ingredientLine(recipe: Recipe, index: number): string | null {
  const ingredient = recipe.ingredients[index]?.trim();
  return ingredient ? `Ingredient ${index + 1}. ${ingredient}` : null;
}

function answerForStep(recipe: Recipe, stepIndex: number): string {
  return spokenStep(recipe, stepIndex) ?? `I have ${recipe.title}, but there are no saved steps yet.`;
}

function answerForCurrentItem(recipe: Recipe, state: VoiceSessionState): string {
  if (state.phase === "ingredients") {
    return ingredientLine(recipe, state.stepIndex) ?? `I have ${recipe.title}, but there are no saved ingredients yet.`;
  }
  return answerForStep(recipe, state.stepIndex);
}

function buildSubstitutionAnswer(transcript: string, recipe: Recipe | null): string {
  const text = normalize(transcript);

  if (text.includes("olive oil") && recipe?.ingredients.some((ingredient) => normalize(ingredient).includes("butter"))) {
    return `Yes. Olive oil can replace butter in ${recipe.title}. Use about the same amount, but the sauce will taste lighter and less rich.`;
  }

  if (text.includes("butter") && recipe?.ingredients.some((ingredient) => normalize(ingredient).includes("olive oil"))) {
    return `Yes. Butter can replace olive oil in ${recipe.title}. Use about the same amount, but it will taste richer.`;
  }

  if (text.includes("olive oil")) {
    return recipe
      ? `Olive oil usually works in ${recipe.title} for sautéing or finishing. Use about the same amount, and expect a lighter result.`
      : "Olive oil usually works for sautéing or finishing. Use about the same amount, and expect a lighter result.";
  }

  return recipe
    ? `Tell me the ingredient you want to swap in ${recipe.title}, and I’ll give you the best substitute.`
    : "Tell me the ingredient you want to swap, and I’ll give you the best substitute.";
}

function buildContextualAnswer(
  transcript: string,
  recipe: Recipe,
  state: VoiceSessionState
): { answerText: string; nextState: VoiceSessionState } | null {
  const text = normalize(transcript);
  const currentText = state.phase === "ingredients" ? recipe.ingredients[state.stepIndex]?.trim() || "" : recipe.instructions[state.stepIndex]?.trim() || "";
  if (/\b(where am i|where are we|what step am i on|what ingredient am i on|which ingredient am i on)\b/.test(text)) {
    return {
      answerText:
        state.phase === "ingredients"
          ? `You’re on ingredient ${state.stepIndex + 1}.`
          : `You’re on step ${state.stepIndex + 1}.`,
      nextState: state
    };
  }

  if (/\b(start over|from the top|begin again|restart)\b/.test(text)) {
    return {
      answerText: state.phase === "ingredients" ? (ingredientLine(recipe, 0) ?? `I have ${recipe.title}, but there are no saved ingredients yet.`) : answerForStep(recipe, 0),
      nextState: { ...state, stepIndex: 0, pendingPrompt: null }
    };
  }

  if (state.phase === "ingredients" && /\b(next ingredient|what s the next ingredient|what is the next ingredient)\b/.test(text)) {
    const nextIndex = state.stepIndex + 1;
    const nextIngredient = ingredientLine(recipe, nextIndex);
    return nextIngredient
      ? { answerText: nextIngredient, nextState: { ...state, stepIndex: nextIndex, pendingPrompt: null } }
      : { answerText: `You’re at the end of the ingredient list for ${recipe.title}.`, nextState: state };
  }

  if (state.phase === "ingredients" && /\b(previous ingredient|last ingredient|ingredient before|go back an ingredient)\b/.test(text)) {
    if (state.stepIndex <= 0) return { answerText: "You’re on the first ingredient already.", nextState: state };
    const previousIndex = state.stepIndex - 1;
    return {
      answerText: ingredientLine(recipe, previousIndex) ?? "I don’t have the previous ingredient saved.",
      nextState: { ...state, stepIndex: previousIndex, pendingPrompt: null }
    };
  }

  if (!currentText) return null;

  if (/\b(degrees?|temperature|hot)\b/.test(text)) {
    const degreeMatch = currentText.match(/(\d{2,3})\s*(degrees?|°\s*[FC]\b|\b[FC]\b)/i);
    if (degreeMatch) {
      const unit = degreeMatch[2].replace(/\s+/g, "");
      const spokenUnit = /degrees?/i.test(unit) ? "degrees" : unit.toUpperCase().replace("°", " ");
      return { answerText: `It says ${degreeMatch[1]} ${spokenUnit}.`, nextState: state };
    }
    return {
      answerText:
        state.phase === "steps"
          ? `This step doesn’t mention a temperature. ${answerForCurrentItem(recipe, state)}`
          : `This ingredient doesn’t mention a temperature. ${answerForCurrentItem(recipe, state)}`,
      nextState: state
    };
  }

  if (/\b(minutes?|hours?|seconds?|how long|time)\b/.test(text)) {
    const durationMatch = currentText.match(/(\d+(?:\s*(?:to|[-–])\s*\d+)?\s*(?:minutes?|hours?|seconds?))/i);
    if (durationMatch) return { answerText: `It says ${durationMatch[1]}.`, nextState: state };
    return {
      answerText:
        state.phase === "steps"
          ? `This step doesn’t mention a time. ${answerForCurrentItem(recipe, state)}`
          : `This ingredient doesn’t mention a time. ${answerForCurrentItem(recipe, state)}`,
      nextState: state
    };
  }

  if (/\b(after that|what next|what comes after this|what comes next|what do i do after that|then what)\b/.test(text) && state.phase === "steps") {
    const nextIndex = state.stepIndex + 1;
    const nextStep = spokenStep(recipe, nextIndex);
    return nextStep
      ? {
          answerText: nextStep,
          nextState: { ...state, stepIndex: nextIndex, pendingPrompt: null }
        }
      : {
          answerText: `You’re at the end of ${recipe.title}. Want ingredients or a repeat?`,
          nextState: { ...state, phase: "steps", pendingPrompt: "ingredients_or_repeat" }
        };
  }

  if (/\b(previous step|step before|what comes before this|what was the last step|before that|go back|back up|previous)\b/.test(text) && state.phase === "steps") {
    if (state.stepIndex <= 0) return { answerText: "You’re on the first step already.", nextState: state };
    const previousIndex = state.stepIndex - 1;
    const previousStep = spokenStep(recipe, previousIndex);
    return {
      answerText: previousStep ?? "I don’t have the previous step saved.",
      nextState: previousStep ? { ...state, stepIndex: previousIndex, pendingPrompt: null } : state
    };
  }

  if (/\b(what step|which step)\b/.test(text) && state.phase === "steps") {
    return { answerText: `You’re on step ${state.stepIndex + 1}.`, nextState: state };
  }

  if (/\b(again|repeat|what was that|say that again)\b/.test(text)) {
    return { answerText: answerForCurrentItem(recipe, state), nextState: state };
  }

  if (/\b(how much|how many|quantity|amount)\b/.test(text) && state.phase === "ingredients") {
    const answerText = ingredientLine(recipe, state.stepIndex);
    return answerText ? { answerText, nextState: state } : null;
  }

  if (/\b(which ingredient|what ingredient)\b/.test(text) && state.phase === "ingredients") {
    const answerText = ingredientLine(recipe, state.stepIndex);
    return answerText ? { answerText, nextState: state } : null;
  }

  return null;
}

function resolvePendingPrompt(transcript: string, currentSession: VoiceSessionState, currentRecipe: Recipe | null): {
  handled: boolean;
  answerText?: string;
  nextState?: VoiceSessionState;
  intent?: AudioIntent;
} {
  if (!currentRecipe || !currentSession.pendingPrompt) return { handled: false };

  if (currentSession.pendingPrompt === "ingredients_or_first_step") {
    if (isIngredientRequest(transcript)) {
      return {
        handled: true,
        intent: "general_help",
        answerText: summarizeIngredients(currentRecipe),
        nextState: currentSession
      };
    }

    if (isFirstStepRequest(transcript)) {
      return {
        handled: true,
        intent: "next_step",
        answerText: answerForStep(currentRecipe, 0),
        nextState: { ...currentSession, phase: "steps", stepIndex: 0, pendingPrompt: null }
      };
    }

    if (isAffirmative(transcript)) {
      return {
        handled: true,
        intent: "general_help",
        answerText: "Do you want the ingredients or the first step?",
        nextState: currentSession
      };
    }
  }

  if (currentSession.pendingPrompt === "ingredients_or_repeat") {
    if (isIngredientRequest(transcript)) {
      return {
        handled: true,
        intent: "general_help",
        answerText: summarizeIngredients(currentRecipe),
        nextState: currentSession
      };
    }

    if (isRepeatRequest(transcript) || isAffirmative(transcript)) {
      return {
        handled: true,
        intent: "repeat_step",
        answerText: answerForStep(currentRecipe, currentSession.stepIndex),
        nextState: { ...currentSession, pendingPrompt: null }
      };
    }
  }

  return { handled: false };
}

function rankRecipesForModel(transcript: string, recipes: Recipe[]): Recipe[] {
  const query = normalize(transcript);
  const queryWords = new Set(words(transcript));

  return [...recipes]
    .map((recipe) => {
      const haystack = normalize([recipe.title, recipe.description, recipe.theme, recipe.effort, ...recipe.tags, ...recipe.ingredients].join(" "));
      let score = 0;
      if (query && haystack.includes(query)) score += 20;
      for (const variant of recipeTokenVariants(recipe.title)) {
        if (query === variant) score += 25;
        else if (query.includes(variant)) score += 12;
      }
      for (const word of queryWords) {
        if (haystack.includes(word)) score += word.length >= 5 ? 3 : 2;
      }
      return { recipe, score };
    })
    .sort((a, b) => b.score - a.score || b.recipe.id - a.recipe.id)
    .slice(0, 8)
    .map(({ recipe }) => recipe);
}

function sanitizeParsedQuery(value: unknown): ParsedQuery | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const allowedActions: ModelAction[] = [
    "search_recipe",
    "load_recipe",
    "get_ingredients",
    "get_current_step",
    "next_step",
    "previous_step",
    "repeat_step",
    "substitution_question",
    "recipe_question",
    "clarify",
    "general_help"
  ];
  const action = typeof candidate.action === "string" && allowedActions.includes(candidate.action as ModelAction) ? (candidate.action as ModelAction) : null;
  if (!action) return null;

  const allowedQuestionTypes: ModelQuestionType[] = ["time", "temperature", "step_number", "ingredient_amount", "ingredient_identity", "other"];
  const questionType =
    typeof candidate.questionType === "string" && allowedQuestionTypes.includes(candidate.questionType as ModelQuestionType)
      ? (candidate.questionType as ModelQuestionType)
      : undefined;

  const answerStyle = candidate.answerStyle === "ingredients" || candidate.answerStyle === "first_step" || candidate.answerStyle === "auto" ? candidate.answerStyle : undefined;

  return {
    action,
    recipeTitle: typeof candidate.recipeTitle === "string" ? candidate.recipeTitle.trim() : undefined,
    recipeId: typeof candidate.recipeId === "number" && Number.isFinite(candidate.recipeId) ? candidate.recipeId : undefined,
    ingredient: typeof candidate.ingredient === "string" ? candidate.ingredient.trim() : undefined,
    question: typeof candidate.question === "string" ? candidate.question.trim() : undefined,
    questionType,
    answerStyle,
    confidence:
      typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1
        ? candidate.confidence
        : undefined
  };
}

function recipeSimilarityScore(query: string, recipe: Recipe): number {
  const normalizedQuery = normalize(query);
  const normalizedTitle = normalize(recipe.title);
  if (!normalizedQuery || !normalizedTitle) return 0;
  if (normalizedQuery === normalizedTitle) return 100;
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) return 85;

  const queryWords = Array.from(new Set(words(query)));
  const titleWords = Array.from(new Set(words(recipe.title)));
  if (queryWords.length === 0 || titleWords.length === 0) return 0;

  const overlap = queryWords.filter((word) => titleWords.includes(word)).length;
  const ratio = overlap / Math.max(queryWords.length, titleWords.length);
  return Math.round(ratio * 100);
}

function findClosestRecipeByTitle(query: string, recipes: Recipe[]): { recipe: Recipe; score: number } | null {
  let best: { recipe: Recipe; score: number } | null = null;
  for (const recipe of recipes) {
    const score = recipeSimilarityScore(query, recipe);
    if (!best || score > best.score) best = { recipe, score };
  }
  return best;
}

function findRecipeByModelSelection(parsed: ParsedQuery, candidates: Recipe[], currentRecipe: Recipe | null): Recipe | null {
  if (parsed.recipeId != null) {
    const byId = candidates.find((recipe) => recipe.id === parsed.recipeId) ?? listRecipes().find((recipe) => recipe.id === parsed.recipeId);
    if (byId) return byId;
  }

  if (parsed.recipeTitle) {
    const title = normalize(parsed.recipeTitle);
    const exact = candidates.find((recipe) => normalize(recipe.title) === title) ?? listRecipes().find((recipe) => normalize(recipe.title) === title);
    if (exact) return exact;

    const closest = findClosestRecipeByTitle(parsed.recipeTitle, listRecipes());
    if (closest && closest.score >= 70) return closest.recipe;
  }

  if (parsed.action !== "search_recipe" && parsed.action !== "load_recipe" && currentRecipe) {
    return currentRecipe;
  }

  return null;
}

async function interpretQueryWithModel(options: {
  transcript: string;
  currentSession: VoiceSessionState;
  currentRecipe: Recipe | null;
  candidateRecipes: Recipe[];
}): Promise<ParsedQuery | null> {
  if (!OPENAI_API_KEY) return null;

  const { transcript, currentSession, currentRecipe, candidateRecipes } = options;
  const recipeCatalog = candidateRecipes.map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    tags: recipe.tags.slice(0, 6),
    ingredients: recipe.ingredients.slice(0, 8)
  }));

  const currentContext = currentRecipe
    ? {
        id: currentRecipe.id,
        title: currentRecipe.title,
        phase: currentSession.phase,
        stepIndex: currentSession.stepIndex,
        pendingPrompt: currentSession.pendingPrompt,
        currentIngredient: currentSession.phase === "ingredients" ? currentRecipe.ingredients[currentSession.stepIndex] ?? null : null,
        currentStep: currentSession.phase === "steps" ? currentRecipe.instructions[currentSession.stepIndex] ?? null : null
      }
    : {
        id: null,
        title: null,
        phase: currentSession.phase,
        stepIndex: currentSession.stepIndex,
        pendingPrompt: currentSession.pendingPrompt,
        currentIngredient: null,
        currentStep: null
      };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    signal: AbortSignal.timeout(12000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: QUERY_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a query parser for a voice-first cooking assistant. Return JSON only. Choose the user's intended action and resolve references using the current recipe/session when possible. Never invent a recipe that is not in the candidate list. Prefer deterministic cooking controls like next_step, previous_step, get_ingredients, repeat_step, load_recipe, or search_recipe. Use recipe_question for questions about the current recipe content like time or temperature. Use substitution_question for swaps/replacements. If ambiguous, return clarify."
        },
        {
          role: "user",
          content: JSON.stringify({
            transcript,
            currentContext,
            candidateRecipes: recipeCatalog,
            outputSchema: {
              action: "search_recipe | load_recipe | get_ingredients | get_current_step | next_step | previous_step | repeat_step | substitution_question | recipe_question | clarify | general_help",
              recipeId: "number | optional",
              recipeTitle: "string | optional",
              ingredient: "string | optional",
              question: "string | optional",
              questionType: "time | temperature | step_number | ingredient_amount | ingredient_identity | other | optional",
              answerStyle: "ingredients | first_step | auto | optional",
              confidence: "0..1"
            }
          })
        }
      ]
    })
  });

  if (!response.ok) return null;
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return sanitizeParsedQuery(JSON.parse(content));
  } catch {
    return null;
  }
}

async function synthesizeSpeech(answerText: string, publicBaseUrl?: string): Promise<{ mimeType: string; url: string } | undefined> {
  if (!OPENAI_API_KEY) return undefined;

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    signal: AbortSignal.timeout(30000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: answerText, format: "mp3" })
  });

  if (!response.ok) throw new Error(`TTS failed: ${await response.text()}`);

  await fs.mkdir(generatedAudioDir, { recursive: true });
  const fileName = `${Date.now()}-${randomUUID()}.mp3`;
  await fs.writeFile(path.join(generatedAudioDir, fileName), Buffer.from(await response.arrayBuffer()));

  const relativeUrl = `/app/api/audio/${fileName}`;
  return { mimeType: "audio/mpeg", url: publicBaseUrl ? `${publicBaseUrl}${relativeUrl}` : relativeUrl };
}

async function transcribeAudio(file: File): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  const form = new FormData();
  form.set("model", TRANSCRIPTION_MODEL);
  form.set("file", file, file.name || "audio-input");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    signal: AbortSignal.timeout(30000),
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });

  if (!response.ok) throw new Error(`Transcription failed: ${await response.text()}`);
  const data = (await response.json()) as { text?: string };
  return data.text?.trim() || "";
}

async function finalizeResponse(options: {
  transcript: string;
  intent: AudioIntent;
  answerText: string;
  sessionId: string;
  nextState: VoiceSessionState;
  includeAudio: boolean;
  publicBaseUrl?: string;
}): Promise<QueryResult> {
  const { transcript, intent, answerText, sessionId, nextState, includeAudio, publicBaseUrl } = options;
  setVoiceSession(sessionId, nextState);

  let audio: { mimeType: string; url: string } | undefined;
  if (includeAudio) {
    try {
      audio = await synthesizeSpeech(answerText, publicBaseUrl);
    } catch {
      audio = undefined;
    }
  }

  return {
    ok: true,
    transcript,
    intent,
    answerText,
    audio,
    session: sessionPayload(sessionId, nextState)
  };
}

export async function handleNextStep(
  sessionId: string,
  options?: { includeAudio?: boolean; publicBaseUrl?: string; transcript?: string }
): Promise<QueryResult> {
  const currentSession = getVoiceSession(sessionId);
  const currentRecipe = findRecipeBySessionId(currentSession.activeRecipeId);

  if (!currentRecipe) {
    return {
      ok: false,
      answerText: "No recipe is loaded yet. Ask for a recipe first.",
      session: sessionPayload(sessionId, currentSession)
    };
  }

  if (currentSession.pendingPrompt === "ingredients_or_first_step") {
    return finalizeResponse({
      transcript: options?.transcript ?? "",
      intent: "next_step",
      answerText: ingredientLine(currentRecipe, 0) ?? `I have ${currentRecipe.title}, but there are no saved ingredients yet.`,
      sessionId,
      nextState: { ...currentSession, activeRecipeId: buildSessionRecipeId(currentRecipe), phase: "ingredients", stepIndex: 0, pendingPrompt: null },
      includeAudio: options?.includeAudio ?? false,
      publicBaseUrl: options?.publicBaseUrl
    });
  }

  if (currentSession.phase === "ingredients") {
    const nextIngredientIndex = currentSession.stepIndex + 1;
    const nextIngredient = ingredientLine(currentRecipe, nextIngredientIndex);
    if (nextIngredient) {
      return finalizeResponse({
        transcript: options?.transcript ?? "",
        intent: "next_step",
        answerText: nextIngredient,
        sessionId,
        nextState: { ...currentSession, phase: "ingredients", stepIndex: nextIngredientIndex, pendingPrompt: null },
        includeAudio: options?.includeAudio ?? false,
        publicBaseUrl: options?.publicBaseUrl
      });
    }

    return finalizeResponse({
      transcript: options?.transcript ?? "",
      intent: "next_step",
      answerText: answerForStep(currentRecipe, 0),
      sessionId,
      nextState: { ...currentSession, phase: "steps", stepIndex: 0, pendingPrompt: null },
      includeAudio: options?.includeAudio ?? false,
      publicBaseUrl: options?.publicBaseUrl
    });
  }

  const nextIndex = currentSession.stepIndex + 1;
  const nextStep = spokenStep(currentRecipe, nextIndex);
  if (!nextStep) {
    return finalizeResponse({
      transcript: options?.transcript ?? "",
      intent: "next_step",
      answerText: `You’re at the end of ${currentRecipe.title}. Want ingredients or a repeat?`,
      sessionId,
      nextState: { ...currentSession, phase: "steps", pendingPrompt: "ingredients_or_repeat" },
      includeAudio: options?.includeAudio ?? false,
      publicBaseUrl: options?.publicBaseUrl
    });
  }

  return finalizeResponse({
    transcript: options?.transcript ?? "",
    intent: "next_step",
    answerText: nextStep,
    sessionId,
    nextState: { ...currentSession, activeRecipeId: buildSessionRecipeId(currentRecipe), phase: "steps", stepIndex: nextIndex, pendingPrompt: null },
    includeAudio: options?.includeAudio ?? false,
    publicBaseUrl: options?.publicBaseUrl
  });
}

async function executeParsedQuery(options: {
  parsed: ParsedQuery;
  transcript: string;
  sessionId: string;
  includeAudio: boolean;
  publicBaseUrl?: string;
  currentSession: VoiceSessionState;
  currentRecipe: Recipe | null;
  candidates: Recipe[];
}): Promise<QueryResult | null> {
  const { parsed, transcript, sessionId, includeAudio, publicBaseUrl, currentSession, currentRecipe, candidates } = options;
  const resolvedRecipe = findRecipeByModelSelection(parsed, candidates, currentRecipe);

  switch (parsed.action) {
    case "get_ingredients": {
      if (!resolvedRecipe) {
        return {
          ok: false,
          transcript,
          intent: "general_help",
          answerText: "No recipe is loaded yet. Ask for a recipe first, then I can read the ingredients.",
          session: sessionPayload(sessionId, currentSession)
        };
      }

      return finalizeResponse({
        transcript,
        intent: "general_help",
        answerText: summarizeIngredients(resolvedRecipe),
        sessionId,
        nextState: {
          activeRecipeId: buildSessionRecipeId(resolvedRecipe),
          phase: "ingredients",
          stepIndex: currentRecipe?.id === resolvedRecipe.id && currentSession.phase === "ingredients" ? currentSession.stepIndex : 0,
          pendingPrompt: null
        },
        includeAudio,
        publicBaseUrl
      });
    }

    case "get_current_step": {
      if (!resolvedRecipe) {
        return {
          ok: false,
          transcript,
          intent: "next_step",
          answerText: "No recipe is loaded yet. Ask for a recipe first.",
          session: sessionPayload(sessionId, currentSession)
        };
      }

      const nextState: VoiceSessionState =
        currentRecipe?.id === resolvedRecipe.id
          ? { ...currentSession, pendingPrompt: null }
          : { activeRecipeId: buildSessionRecipeId(resolvedRecipe), phase: "steps", stepIndex: 0, pendingPrompt: null };

      const effectiveIndex = nextState.phase === "steps" ? nextState.stepIndex : 0;
      return finalizeResponse({
        transcript,
        intent: "repeat_step",
        answerText: answerForStep(resolvedRecipe, effectiveIndex),
        sessionId,
        nextState: { ...nextState, phase: "steps", stepIndex: effectiveIndex, pendingPrompt: null },
        includeAudio,
        publicBaseUrl
      });
    }

    case "next_step":
      return handleNextStep(sessionId, { includeAudio, publicBaseUrl, transcript });

    case "previous_step": {
      if (!currentRecipe) {
        return {
          ok: false,
          transcript,
          intent: "general_help",
          answerText: "No recipe is loaded yet. Ask for a recipe first.",
          session: sessionPayload(sessionId, currentSession)
        };
      }
      if (currentSession.phase !== "steps") {
        return finalizeResponse({
          transcript,
          intent: "general_help",
          answerText: answerForStep(currentRecipe, 0),
          sessionId,
          nextState: { ...currentSession, phase: "steps", stepIndex: 0, pendingPrompt: null },
          includeAudio,
          publicBaseUrl
        });
      }
      if (currentSession.stepIndex <= 0) {
        return finalizeResponse({
          transcript,
          intent: "general_help",
          answerText: "You’re on the first step already.",
          sessionId,
          nextState: { ...currentSession, pendingPrompt: null },
          includeAudio,
          publicBaseUrl
        });
      }
      const previousIndex = currentSession.stepIndex - 1;
      return finalizeResponse({
        transcript,
        intent: "general_help",
        answerText: answerForStep(currentRecipe, previousIndex),
        sessionId,
        nextState: { ...currentSession, phase: "steps", stepIndex: previousIndex, pendingPrompt: null },
        includeAudio,
        publicBaseUrl
      });
    }

    case "repeat_step": {
      if (!currentRecipe) {
        return {
          ok: false,
          transcript,
          intent: "repeat_step",
          answerText: "No recipe is loaded yet. Ask for a recipe first.",
          session: sessionPayload(sessionId, currentSession)
        };
      }
      return finalizeResponse({
        transcript,
        intent: "repeat_step",
        answerText: answerForCurrentItem(currentRecipe, currentSession),
        sessionId,
        nextState: { ...currentSession, pendingPrompt: null },
        includeAudio,
        publicBaseUrl
      });
    }

    case "substitution_question": {
      return finalizeResponse({
        transcript,
        intent: "substitution_question",
        answerText: buildSubstitutionAnswer(parsed.question || transcript, currentRecipe ?? resolvedRecipe),
        sessionId,
        nextState: { ...currentSession, pendingPrompt: null },
        includeAudio,
        publicBaseUrl
      });
    }

    case "recipe_question": {
      const recipe = currentRecipe ?? resolvedRecipe;
      if (!recipe) {
        return {
          ok: false,
          transcript,
          intent: "general_help",
          answerText: "No recipe is loaded yet. Ask for a recipe first.",
          session: sessionPayload(sessionId, currentSession)
        };
      }

      const recipeQuestionState: VoiceSessionState =
        currentRecipe?.id === recipe.id
          ? currentSession
          : { activeRecipeId: buildSessionRecipeId(recipe), phase: "steps", stepIndex: 0, pendingPrompt: null };

      const contextualAnswer = buildContextualAnswer(parsed.question || transcript, recipe, recipeQuestionState);
      if (contextualAnswer) {
        const nextState: VoiceSessionState = currentRecipe?.id === recipe.id ? contextualAnswer.nextState : recipeQuestionState;
        return finalizeResponse({
          transcript,
          intent: "general_help",
          answerText: contextualAnswer.answerText,
          sessionId,
          nextState,
          includeAudio,
          publicBaseUrl
        });
      }
      return finalizeResponse({
        transcript,
        intent: "general_help",
        answerText: answerForCurrentItem(recipe, recipeQuestionState),
        sessionId,
        nextState: currentRecipe?.id === recipe.id ? { ...currentSession, pendingPrompt: null } : recipeQuestionState,
        includeAudio,
        publicBaseUrl
      });
    }

    case "search_recipe":
    case "load_recipe": {
      const transcriptRequestedTitle = extractRecipeRequestLabel(transcript);
      const explicitRequestedTitle = transcriptRequestedTitle !== "that recipe" ? transcriptRequestedTitle : parsed.recipeTitle?.trim() || "that recipe";
      const resolvedMatchScore = resolvedRecipe ? recipeSimilarityScore(explicitRequestedTitle, resolvedRecipe) : 0;

      if (!resolvedRecipe || resolvedMatchScore < 70) {
        logQueryDecision("model_missing_recipe", {
          transcript,
          action: parsed.action,
          requestedTitle: explicitRequestedTitle,
          resolvedRecipe: resolvedRecipe?.title ?? null,
          resolvedMatchScore,
          currentRecipe: currentRecipe?.title ?? null
        });
        return finalizeResponse({
          transcript,
          intent: "general_help",
          answerText: missingRecipeAnswer(explicitRequestedTitle, transcript, currentRecipe),
          sessionId,
          nextState: currentSession,
          includeAudio,
          publicBaseUrl
        });
      }

      const wantsFirstStep = parsed.action === "load_recipe" || parsed.answerStyle === "first_step";
      if (wantsFirstStep) {
        return finalizeResponse({
          transcript,
          intent: "load_recipe",
          answerText: answerForStep(resolvedRecipe, 0),
          sessionId,
          nextState: { activeRecipeId: buildSessionRecipeId(resolvedRecipe), phase: "steps", stepIndex: 0, pendingPrompt: null },
          includeAudio,
          publicBaseUrl
        });
      }
      return finalizeResponse({
        transcript,
        intent: "recipe_lookup",
        answerText: `I found ${resolvedRecipe.title}. Want ingredients or the first step?`,
        sessionId,
        nextState: {
          activeRecipeId: buildSessionRecipeId(resolvedRecipe),
          phase: "ingredients",
          stepIndex: 0,
          pendingPrompt: "ingredients_or_first_step"
        },
        includeAudio,
        publicBaseUrl
      });
    }

    case "clarify": {
      if (soundsLikeRecipeRequest(transcript)) {
        const requestedTitle = extractRecipeRequestLabel(transcript);
        logQueryDecision("model_clarify_recipe_request", {
          transcript,
          requestedTitle,
          currentRecipe: currentRecipe?.title ?? null
        });
        return finalizeResponse({
          transcript,
          intent: "general_help",
          answerText: missingRecipeAnswer(requestedTitle, transcript, currentRecipe),
          sessionId,
          nextState: currentSession,
          includeAudio,
          publicBaseUrl
        });
      }
      return finalizeResponse({
        transcript,
        intent: "general_help",
        answerText: currentRecipe ? "Do you want ingredients, the current step, or the next step?" : "Do you want to load a recipe, hear ingredients, or start with the first step?",
        sessionId,
        nextState: currentSession,
        includeAudio,
        publicBaseUrl
      });
    }

    case "general_help":
    default:
      return null;
  }
}

export async function handleTextQuery(options: {
  transcript: string;
  publicBaseUrl?: string;
  sessionId: string;
  includeAudio?: boolean;
}): Promise<QueryResult> {
  const { transcript, publicBaseUrl, sessionId, includeAudio = false } = options;
  const cleanedTranscript = transcript.trim();

  if (!cleanedTranscript) {
    return {
      ok: false,
      answerText: "Sorry, I didn’t catch that.",
      session: sessionPayload(sessionId, getVoiceSession(sessionId))
    };
  }

  const currentSession = getVoiceSession(sessionId);
  const currentRecipe = findRecipeBySessionId(currentSession.activeRecipeId);

  if (currentRecipe && currentSession.phase === "ingredients") {
    const requestedIngredientIndex = extractRequestedIngredientIndex(cleanedTranscript);
    if (requestedIngredientIndex != null) {
      const requestedIngredient = ingredientLine(currentRecipe, requestedIngredientIndex);
      return finalizeResponse({
        transcript: cleanedTranscript,
        intent: "general_help",
        answerText: requestedIngredient ?? `I only have ${currentRecipe.ingredients.length} ingredients saved for ${currentRecipe.title}.`,
        sessionId,
        nextState: requestedIngredient ? { ...currentSession, stepIndex: requestedIngredientIndex, pendingPrompt: null } : currentSession,
        includeAudio,
        publicBaseUrl
      });
    }
  }

  if (currentRecipe && currentSession.phase === "ingredients" && isNextIngredientRequest(cleanedTranscript)) {
    const nextIndex = currentSession.stepIndex + 1;
    const nextIngredient = ingredientLine(currentRecipe, nextIndex);
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: nextIngredient ?? `You’re at the end of the ingredient list for ${currentRecipe.title}.`,
      sessionId,
      nextState: nextIngredient ? { ...currentSession, stepIndex: nextIndex, pendingPrompt: null } : currentSession,
      includeAudio,
      publicBaseUrl
    });
  }

  if (currentRecipe && currentSession.phase === "ingredients" && isPreviousIngredientRequest(cleanedTranscript)) {
    if (currentSession.stepIndex <= 0) {
      return finalizeResponse({
        transcript: cleanedTranscript,
        intent: "general_help",
        answerText: "You’re on the first ingredient already.",
        sessionId,
        nextState: currentSession,
        includeAudio,
        publicBaseUrl
      });
    }
    const previousIndex = currentSession.stepIndex - 1;
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: ingredientLine(currentRecipe, previousIndex) ?? "I don’t have the previous ingredient saved.",
      sessionId,
      nextState: { ...currentSession, stepIndex: previousIndex, pendingPrompt: null },
      includeAudio,
      publicBaseUrl
    });
  }

  if (!currentRecipe && isIngredientRequest(cleanedTranscript)) {
    return {
      ok: false,
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: "No recipe is loaded yet. Ask for a recipe first, then I can read the ingredients.",
      session: sessionPayload(sessionId, currentSession)
    };
  }

  if (currentRecipe && isIngredientRequest(cleanedTranscript)) {
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: summarizeIngredients(currentRecipe),
      sessionId,
      nextState: { ...currentSession, phase: "ingredients" },
      includeAudio,
      publicBaseUrl
    });
  }

  if (!currentRecipe && isFirstStepRequest(cleanedTranscript)) {
    return {
      ok: false,
      transcript: cleanedTranscript,
      intent: "next_step",
      answerText: "No recipe is loaded yet. Ask for a recipe first, then I can give you the first step.",
      session: sessionPayload(sessionId, currentSession)
    };
  }

  if (currentRecipe && isFirstStepRequest(cleanedTranscript)) {
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "next_step",
      answerText: answerForStep(currentRecipe, 0),
      sessionId,
      nextState: { ...currentSession, phase: "steps", stepIndex: 0, pendingPrompt: null },
      includeAudio,
      publicBaseUrl
    });
  }

  if (currentRecipe && isWhereAmIRequest(cleanedTranscript)) {
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: currentSession.phase === "ingredients" ? `You’re on ingredient ${currentSession.stepIndex + 1}.` : `You’re on step ${currentSession.stepIndex + 1}.`,
      sessionId,
      nextState: currentSession,
      includeAudio,
      publicBaseUrl
    });
  }

  if (currentRecipe && isStartOverRequest(cleanedTranscript)) {
    const nextState: VoiceSessionState = { ...currentSession, stepIndex: 0, pendingPrompt: null };
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: nextState.phase === "ingredients" ? (ingredientLine(currentRecipe, 0) ?? `I have ${currentRecipe.title}, but there are no saved ingredients yet.`) : answerForStep(currentRecipe, 0),
      sessionId,
      nextState,
      includeAudio,
      publicBaseUrl
    });
  }

  if (currentRecipe && currentSession.phase === "ingredients" && isNextIngredientRequest(cleanedTranscript)) {
    const nextIndex = currentSession.stepIndex + 1;
    const nextIngredient = ingredientLine(currentRecipe, nextIndex);
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: nextIngredient ?? `You’re at the end of the ingredient list for ${currentRecipe.title}.`,
      sessionId,
      nextState: nextIngredient ? { ...currentSession, stepIndex: nextIndex, pendingPrompt: null } : currentSession,
      includeAudio,
      publicBaseUrl
    });
  }

  if (currentRecipe && currentSession.phase === "ingredients" && isPreviousIngredientRequest(cleanedTranscript)) {
    if (currentSession.stepIndex <= 0) {
      return finalizeResponse({
        transcript: cleanedTranscript,
        intent: "general_help",
        answerText: "You’re on the first ingredient already.",
        sessionId,
        nextState: currentSession,
        includeAudio,
        publicBaseUrl
      });
    }
    const previousIndex = currentSession.stepIndex - 1;
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: ingredientLine(currentRecipe, previousIndex) ?? "I don’t have the previous ingredient saved.",
      sessionId,
      nextState: { ...currentSession, stepIndex: previousIndex, pendingPrompt: null },
      includeAudio,
      publicBaseUrl
    });
  }

  const contextualAnswer = currentRecipe ? buildContextualAnswer(cleanedTranscript, currentRecipe, currentSession) : null;
  if (contextualAnswer) {
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: "general_help",
      answerText: contextualAnswer.answerText,
      sessionId,
      nextState: contextualAnswer.nextState,
      includeAudio,
      publicBaseUrl
    });
  }

  const pendingResolution = resolvePendingPrompt(cleanedTranscript, currentSession, currentRecipe);
  if (pendingResolution.handled) {
    return finalizeResponse({
      transcript: cleanedTranscript,
      intent: pendingResolution.intent || "general_help",
      answerText: pendingResolution.answerText || "",
      sessionId,
      nextState: pendingResolution.nextState || currentSession,
      includeAudio,
      publicBaseUrl
    });
  }

  const candidates = rankRecipesForModel(cleanedTranscript, listRecipes());
  try {
    const parsed = await interpretQueryWithModel({
      transcript: cleanedTranscript,
      currentSession,
      currentRecipe,
      candidateRecipes: candidates
    });

    if (parsed) {
      logQueryDecision("model_parsed", {
        transcript: cleanedTranscript,
        action: parsed.action,
        parsedRecipeTitle: parsed.recipeTitle ?? null,
        parsedRecipeId: parsed.recipeId ?? null,
        currentRecipe: currentRecipe?.title ?? null
      });
      const executed = await executeParsedQuery({
        parsed,
        transcript: cleanedTranscript,
        sessionId,
        includeAudio,
        publicBaseUrl,
        currentSession,
        currentRecipe,
        candidates
      });
      if (executed) return executed;
      logQueryDecision("model_fallback", {
        transcript: cleanedTranscript,
        action: parsed.action,
        currentRecipe: currentRecipe?.title ?? null
      });
    }
  } catch {
    // Fall through to deterministic heuristics.
  }

  const resolvedRecipe = findRecipeFromTranscript(cleanedTranscript) ?? currentRecipe;
  const intent = detectIntent(cleanedTranscript, resolvedRecipe);
  logQueryDecision("heuristic_intent", {
    transcript: cleanedTranscript,
    intent,
    resolvedRecipe: resolvedRecipe?.title ?? null,
    currentRecipe: currentRecipe?.title ?? null
  });
  let nextState: VoiceSessionState = { ...currentSession };
  let answerText = "Ask for a recipe, the next step, a substitution, or a repeat.";

  switch (intent) {
    case "recipe_lookup": {
      const requestedTitle = extractRecipeRequestLabel(cleanedTranscript);
      const closestMatch = findClosestRecipeByTitle(requestedTitle, listRecipes());
      if (!resolvedRecipe || (requestedTitle && closestMatch && closestMatch.score < 70)) {
        answerText = missingRecipeAnswer(requestedTitle, cleanedTranscript, currentRecipe);
        break;
      }
      nextState = {
        activeRecipeId: buildSessionRecipeId(resolvedRecipe),
        phase: "ingredients",
        stepIndex: 0,
        pendingPrompt: "ingredients_or_first_step"
      };
      answerText = `I found ${resolvedRecipe.title}. Want ingredients or the first step?`;
      break;
    }

    case "load_recipe": {
      const requestedTitle = extractRecipeRequestLabel(cleanedTranscript);
      const closestMatch = findClosestRecipeByTitle(requestedTitle, listRecipes());
      if (!resolvedRecipe || (requestedTitle && closestMatch && closestMatch.score < 70)) {
        answerText = missingRecipeAnswer(requestedTitle, cleanedTranscript, currentRecipe);
        break;
      }
      nextState = {
        activeRecipeId: buildSessionRecipeId(resolvedRecipe),
        phase: "steps",
        stepIndex: 0,
        pendingPrompt: null
      };
      answerText = answerForStep(resolvedRecipe, 0);
      break;
    }

    case "next_step":
      return handleNextStep(sessionId, { includeAudio, publicBaseUrl, transcript: cleanedTranscript });

    case "repeat_step": {
      const activeRecipe = currentRecipe ?? resolvedRecipe;
      if (!activeRecipe) {
        answerText = "No recipe is loaded yet. Ask for a recipe first.";
        break;
      }
      answerText = spokenStep(activeRecipe, currentSession.stepIndex) ?? `I don’t have a current step to repeat for ${activeRecipe.title}.`;
      nextState = { ...currentSession, pendingPrompt: null };
      break;
    }

    case "substitution_question": {
      answerText = buildSubstitutionAnswer(cleanedTranscript, currentRecipe ?? resolvedRecipe);
      nextState = { ...currentSession, pendingPrompt: null };
      break;
    }

    case "general_help": {
      if (soundsLikeRecipeRequest(cleanedTranscript)) {
        const requestedTitle = extractRecipeRequestLabel(cleanedTranscript);
        answerText = missingRecipeAnswer(requestedTitle, cleanedTranscript, currentRecipe);
        break;
      }

      const suggestedRecipe = recommendRecipeFromTranscript(cleanedTranscript);
      if (suggestedRecipe) {
        nextState = {
          activeRecipeId: buildSessionRecipeId(suggestedRecipe),
          phase: "ingredients",
          stepIndex: 0,
          pendingPrompt: "ingredients_or_first_step"
        };
        answerText = `Try ${suggestedRecipe.title}. Want ingredients or the first step?`;
      }
      break;
    }
  }

  return finalizeResponse({
    transcript: cleanedTranscript,
    intent,
    answerText,
    sessionId,
    nextState,
    includeAudio,
    publicBaseUrl
  });
}

export async function handleAudioQuery(options: {
  file: File;
  publicBaseUrl?: string;
  sessionId: string;
}): Promise<QueryResult> {
  const { file, publicBaseUrl, sessionId } = options;

  if (!isSupportedAudioFile(file)) {
    return { ok: false, answerText: "Sorry, that audio format is not supported.", session: sessionPayload(sessionId, getVoiceSession(sessionId)) };
  }

  if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
    return { ok: false, answerText: "Sorry, that audio file is too large or empty.", session: sessionPayload(sessionId, getVoiceSession(sessionId)) };
  }

  const transcript = await transcribeAudio(file);
  return handleTextQuery({ transcript, publicBaseUrl, sessionId, includeAudio: true });
}
