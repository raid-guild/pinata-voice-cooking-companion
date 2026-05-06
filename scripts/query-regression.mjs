import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.QUERY_BASE_URL || "http://127.0.0.1:3000/app/query";
const fixturePath = process.env.QUERY_FIXTURES || path.join(process.cwd(), "workspace", "query-regression-fixtures.json");

const fixtures = JSON.parse(await fs.readFile(fixturePath, "utf8"));

async function sendQuery(sessionId, query) {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, inputMode: "query", query })
  });

  const json = await response.json();
  return { status: response.status, json };
}

function assertCondition(condition, message, failures) {
  if (!condition) failures.push(message);
}

function checkExpectations(result, expect, failures) {
  if (!expect) return;
  if (Object.hasOwn(expect, "ok")) {
    assertCondition(result.ok === expect.ok, `expected ok=${expect.ok}, got ${result.ok}`, failures);
  }
  if (expect.intent) {
    assertCondition(result.intent === expect.intent, `expected intent=${expect.intent}, got ${result.intent}`, failures);
  }
  if (Array.isArray(expect.answerIncludes)) {
    for (const part of expect.answerIncludes) {
      assertCondition(String(result.answerText || "").includes(part), `expected answer to include ${JSON.stringify(part)}, got ${JSON.stringify(result.answerText)}`, failures);
    }
  }
  if (expect.sessionPhase) {
    assertCondition(result.session?.phase === expect.sessionPhase, `expected session.phase=${expect.sessionPhase}, got ${result.session?.phase}`, failures);
  }
  if (expect.activeRecipeIdIncludes) {
    assertCondition(String(result.session?.activeRecipeId || "").includes(expect.activeRecipeIdIncludes), `expected activeRecipeId to include ${expect.activeRecipeIdIncludes}, got ${result.session?.activeRecipeId}`, failures);
  }
  if (expect.activeRecipeIdNull) {
    assertCondition(result.session?.activeRecipeId == null, `expected activeRecipeId to be null, got ${result.session?.activeRecipeId}`, failures);
  }
}

let passed = 0;
let failed = 0;

for (const fixture of fixtures) {
  const sessionId = fixture.sessionId;
  const failures = [];

  for (const setupQuery of fixture.before || []) {
    const setupResult = await sendQuery(sessionId, setupQuery);
    if (!setupResult.json?.ok) {
      failures.push(`setup query failed: ${JSON.stringify(setupQuery)} => ${JSON.stringify(setupResult.json)}`);
      break;
    }
  }

  const result = failures.length === 0 ? await sendQuery(sessionId, fixture.query) : null;
  if (result) {
    checkExpectations(result.json, fixture.expect, failures);
  }

  if (failures.length === 0) {
    passed += 1;
    console.log(`PASS ${fixture.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${fixture.name}`);
    for (const failure of failures) console.log(`  - ${failure}`);
    if (result) console.log(`  response: ${JSON.stringify(result.json)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
