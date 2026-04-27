"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Recipe = {
  id: number;
  title: string;
  sourceUrl: string;
  imageUrl: string;
  description: string;
  ingredients: string[];
  instructions: string[];
  tags: string[];
  effort: string;
  theme: string;
  notes: string;
};

type FoodEvent = {
  id: number;
  title: string;
  body: string;
  kind: "note" | "cooked" | "plan" | "suggestion";
  recipeId: number | null;
  recipeTitle: string;
  createdAt: string;
};

export default function ChefApp() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [events, setEvents] = useState<FoodEvent[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("Loading recipes...");

  const selected = useMemo(
    () => recipes.find((recipe) => recipe.id === selectedId) ?? recipes[0],
    [recipes, selectedId]
  );

  async function loadRecipes(query = search) {
    try {
      const response = await fetch(`/app/api/recipes?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`Recipe request failed: ${response.status}`);
      const data = (await response.json()) as { recipes: Recipe[] };
      setRecipes(data.recipes);
      setSelectedId((current) => current ?? data.recipes[0]?.id ?? null);
      setStatus(`${data.recipes.length} recipe${data.recipes.length === 1 ? "" : "s"} saved`);
    } catch {
      setRecipes([]);
      setSelectedId(null);
      setStatus("Couldn’t load recipes.");
    }
  }

  async function loadEvents() {
    try {
      const response = await fetch("/app/api/events?limit=12");
      if (!response.ok) throw new Error(`Events request failed: ${response.status}`);
      const data = (await response.json()) as { events: FoodEvent[] };
      setEvents(data.events);
    } catch {
      setEvents([]);
    }
  }

  useEffect(() => {
    void loadRecipes("");
    void loadEvents();
  }, []);

  async function searchRecipes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadRecipes(search);
  }

  async function explore(term: string) {
    setSearch(term);
    await loadRecipes(term);
  }

  function surprise() {
    if (recipes.length === 0) return;
    const index = Math.floor(Math.random() * recipes.length);
    setSelectedId(recipes[index].id);
  }

  const facets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const recipe of recipes) {
      [recipe.theme, recipe.effort, ...recipe.tags].filter(Boolean).forEach((facet) => {
        counts.set(facet, (counts.get(facet) ?? 0) + 1);
      });
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);
  }, [recipes]);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="hero-mark">
            <span>Pinata agent template</span>
            <span className="raid-stamp" aria-label="by RaidGuild">by RaidGuild</span>
          </p>
          <h1>Pinata Voice Cooking Companion</h1>
          <p className="lede">
            Browse saved recipes, scan ingredients and notes, and search your kitchen memory by
            mood, effort, ingredient, or theme.
          </p>
        </div>
        <div className="importer">
          <p className="eyebrow">Read-only explorer</p>
          <p>
            Add recipes through the Pinata chat UI. Paste a URL there and the agent can walk you
            through scraping, cleanup, and saving.
          </p>
          <span>{status}</span>
        </div>
      </section>

      <section className="workspace">
        <aside className="sidebar">
          <form className="search" onSubmit={searchRecipes}>
            <input
              aria-label="Search recipes"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search theme, food, effort"
            />
            <button type="submit">Search</button>
          </form>

          <div className="recipe-list">
            {recipes.map((recipe) => (
              <button
                className={recipe.id === selected?.id ? "recipe-item active" : "recipe-item"}
                key={recipe.id}
                onClick={() => setSelectedId(recipe.id)}
                type="button"
              >
                <span>{recipe.title}</span>
                <small>{[recipe.effort, recipe.theme].filter(Boolean).join(" / ") || "saved recipe"}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="detail">
          {selected ? (
            <>
              <div className="event-band">
                <div className="event-band-header">
                  <div>
                    <p className="eyebrow">Food events</p>
                    <h3>Kitchen Timeline</h3>
                  </div>
                  <span>{events.length} recent</span>
                </div>
                <div className="timeline">
                  {events.length > 0 ? (
                    events.map((event) => (
                      <article className="event" key={event.id}>
                        <time dateTime={event.createdAt}>
                          {new Date(`${event.createdAt}Z`).toLocaleDateString([], {
                            month: "short",
                            day: "numeric"
                          })}
                        </time>
                        <div>
                          <span>{event.kind}</span>
                          <h4>{event.title}</h4>
                          <p>{event.body}</p>
                          {event.recipeTitle ? <small>{event.recipeTitle}</small> : null}
                        </div>
                      </article>
                    ))
                  ) : (
                    <p>No food events yet. Add cooking notes and plans through Pinata chat.</p>
                  )}
                </div>
              </div>
              {selected.imageUrl ? (
                <div className="recipe-visual compact">
                  <img alt="" src={selected.imageUrl} />
                </div>
              ) : null}
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{selected.tags.join(" / ") || "recipe"}</p>
                  <h2>{selected.title}</h2>
                  <p>{selected.description || "No description yet. Add notes as you cook it."}</p>
                </div>
                {selected.sourceUrl ? (
                  <a href={selected.sourceUrl} rel="noreferrer" target="_blank">
                    Source
                  </a>
                ) : null}
              </div>

              <div className="columns">
                <div>
                  <h3>Ingredients</h3>
                  <ul>
                    {selected.ingredients.length > 0 ? selected.ingredients.map((item) => <li key={item}>{item}</li>) : <li>Add ingredients after import.</li>}
                  </ul>
                </div>
                <div>
                  <h3>Method</h3>
                  <ol>
                    {selected.instructions.length > 0 ? selected.instructions.map((item) => <li key={item}>{item}</li>) : <li>Add instructions or ask the agent for a pivot.</li>}
                  </ol>
                </div>
              </div>

              <div className="notes">
                <h3>Cooking Notes</h3>
                <p>{selected.notes || "No notes yet."}</p>
              </div>
            </>
          ) : (
            <div className="empty">Import or add a recipe to start building your kitchen memory.</div>
          )}
        </section>

        <aside className="explorer-panel">
          <h3>Explore Lenses</h3>
          <div className="stat-grid">
            <div>
              <strong>{recipes.length}</strong>
              <span>Recipes</span>
            </div>
            <div>
              <strong>{new Set(recipes.flatMap((recipe) => recipe.tags)).size}</strong>
              <span>Tags</span>
            </div>
          </div>

          <div className="lens-grid">
            <button onClick={() => explore("")} type="button">All</button>
            <button onClick={() => explore("easy")} type="button">Easy</button>
            <button onClick={() => explore("comfort")} type="button">Comfort</button>
            <button onClick={surprise} type="button">Surprise</button>
          </div>

          <div className="facet-cloud">
            <p className="eyebrow">Top facets</p>
            {facets.length > 0 ? facets.map(([facet, count]) => (
              <button key={facet} onClick={() => explore(facet)} type="button">
                <span>{facet}</span>
                <small>{count}</small>
              </button>
            )) : <span className="muted">No facets yet.</span>}
          </div>

          <div className="activity-shortcuts">
            <p className="eyebrow">Recent activity</p>
            {events.slice(0, 4).map((event) => (
              <button
                key={event.id}
                onClick={() => {
                  if (event.recipeId) setSelectedId(event.recipeId);
                }}
                type="button"
              >
                <span>{event.title}</span>
                <small>{event.kind}{event.recipeTitle ? ` / ${event.recipeTitle}` : ""}</small>
              </button>
            ))}
          </div>
        </aside>
      </section>
      <footer className="footer">
        Built by RaidGuild. Free and open source.
      </footer>
    </main>
  );
}
