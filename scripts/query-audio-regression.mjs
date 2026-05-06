import fs from "node:fs/promises";
import path from "node:path";

const queryBaseUrl = process.env.QUERY_BASE_URL || "http://127.0.0.1:3000/app/query";
const audioBaseUrl = process.env.QUERY_AUDIO_BASE_URL || "http://127.0.0.1:3000/app/query-audio";
const fixturePath = process.env.QUERY_AUDIO_FIXTURES || path.join(process.cwd(), "workspace", "query-audio-regression-fixtures.json");

const fixtures = JSON.parse(await fs.readFile(fixturePath, "utf8"));

async function sendQuery(sessionId, query) {
  const response = await fetch(queryBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, inputMode: "query", query })
  });
  return { status: response.status, json: await response.json() };
}

async function sendAudioJson(body) {
  const response = await fetch(audioBaseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
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
}

let passed = 0;
let failed = 0;

for (const fixture of fixtures) {
  const failures = [];
  for (const setupQuery of fixture.beforeQuery || []) {
    const setupResult = await sendQuery(fixture.sessionId, setupQuery);
    if (!setupResult.json?.ok) {
      failures.push(`setup query failed: ${JSON.stringify(setupQuery)} => ${JSON.stringify(setupResult.json)}`);
      break;
    }
  }

  let result = null;
  if (failures.length === 0) {
    if (fixture.request?.kind === "json") {
      result = await sendAudioJson(fixture.request.body);
    } else {
      failures.push(`unsupported request kind: ${fixture.request?.kind}`);
    }
  }

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
