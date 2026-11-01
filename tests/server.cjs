// Pruebas del servidor HTTP (server/server.cjs). Corren con `npm test` tras el build.
// SIN EJECUTAR EN LA VM DE FLU3NCE; correr en Hetzner o en CI.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer, loadConfig, ConfigError } = require("../server/server.cjs");

const KEY = "k".repeat(40);
const OLD_KEY = "o".repeat(40);
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/simple-process.json"), "utf8"));
let srv;
let base;

before(async () => {
  srv = createServer(loadConfig({ DIAGRAMSERVICE_API_KEYS: `${KEY},${OLD_KEY}`, MAX_BODY_BYTES: "200000" }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));

async function call(method, p, body, key = KEY, ctype = "application/json; charset=utf-8") {
  const headers = {};
  if (key) headers["X-API-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = ctype;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test("configuracion: sin clave o con clave corta no arranca", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ DIAGRAMSERVICE_API_KEYS: "corta" }), ConfigError);
});

test("sin clave o con otra: 401 en todas las rutas", async () => {
  for (const [m, p] of [["GET", "/health"], ["POST", "/generate"], ["GET", "/nada"]]) {
    assert.equal((await call(m, p, undefined, null)).status, 401);
    assert.equal((await call(m, p, undefined, "x".repeat(40))).status, 401);
  }
});

test("health con cualquiera de las claves de la lista", async () => {
  for (const k of [KEY, OLD_KEY]) {
    const r = await call("GET", "/health", undefined, k);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
  }
});

test("generate, to-contract y update-references", async () => {
  const g = await call("POST", "/generate", { contract, options: { refMaxLenPx: 0 } });
  assert.equal(g.status, 200);
  assert.match(g.json.xml, /bpmn:definitions/);
  assert.deepEqual(g.json.stats, { nodes: contract.nodes.length, edges: contract.edges.length, lanes: contract.lanes.length });
  assert.ok(Array.isArray(g.json.warnings) && Array.isArray(g.json.refs));
  assert.equal(typeof g.json.pagination, "object");
  const c = await call("POST", "/to-contract", { xml: g.json.xml });
  assert.equal(c.status, 200);
  assert.equal(c.json.contract.schemaVersion, "contrato-a");
  assert.equal(c.json.contract.nodes.length, contract.nodes.length);
  const u = await call("POST", "/update-references", { xml: g.json.xml, refMaxLenPx: 600 });
  assert.equal(u.status, 200);
  assert.match(u.json.xml, /bpmndi:BPMNDiagram/);
  assert.equal(typeof u.json.pages, "object");
  assert.ok(Array.isArray(u.json.refs));
});

test("contrato invalido: 422 con issues", async () => {
  const sinFin = { ...contract, nodes: contract.nodes.filter((n) => n.type !== "endEvent") };
  const g = await call("POST", "/generate", { contract: sinFin });
  assert.equal(g.status, 422);
  assert.equal(g.json.error, "graph_invalid");
  assert.ok(g.json.issues.length > 0);
  const fuera = { ...contract, nodes: contract.nodes.map((n, i) => (i === 0 ? { ...n, type: "subProcess" } : n)) };
  const f = await call("POST", "/generate", { contract: fuera });
  assert.equal(f.status, 422);
  assert.equal(f.json.error, "contract_invalid");
  assert.equal((await call("POST", "/generate", { contract: { nodes: 1 } })).status, 422);
});

test("errores de la peticion", async () => {
  assert.equal((await call("POST", "/generate", "{no json")).status, 400);
  assert.equal((await call("POST", "/generate", { contract }, KEY, "text/plain")).status, 415);
  assert.equal((await call("GET", "/generate")).status, 405);
  assert.equal((await call("GET", "/nada")).status, 404);
  assert.equal((await call("POST", "/to-contract", { xml: "<no-es-bpmn/>" })).status, 422);
  assert.equal((await call("POST", "/to-contract", {})).status, 400);
  assert.equal((await call("POST", "/generate", { contract, options: { refMaxLenPx: -1 } })).status, 400);
  assert.equal((await call("POST", "/to-contract", { xml: "<a>" + "x".repeat(300000) + "</a>" })).status, 413);
});
