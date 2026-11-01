"use strict";
/**
 * Servidor HTTP minimo sobre flu3nce-bpmn-pipeline, para el despliegue en
 * Hetzner (rama deploy/hetzner, 1-nov-2026). Ver docs/DEPLOY-HETZNER.md.
 *
 * SIN EJECUTAR EN LA VM DE FLU3NCE (regla: nada de codigo de terceros alli);
 * PROBAR EN HETZNER (npm test incluye tests/server.cjs).
 *
 * Cambio AISLADO: solo modulos de Node (sin dependencias nuevas) y solo usa
 * la API publica del paquete (../dist/index.js, tras `npm run build`). No toca
 * src/. Esta en JavaScript (no en src/) porque el tsconfig no tiene @types/node.
 *
 * Rutas (todas exigen X-API-Key, tambien /health):
 *   GET  /health             -> 200 {status:"ok", service, version}
 *   POST /generate           {contract, options?:{refMaxLenPx?}}
 *                            -> 200 {xml, warnings, stats, refs, pagination}
 *   POST /to-contract        {xml} -> 200 {contract}
 *   POST /update-references  {xml, refMaxLenPx?, forceRef?, forceLine?}
 *                            -> 200 {xml, pages, refs}
 * Errores: {error: <codigo>, message, issues?: [string]}
 *   400 invalid_json | invalid_request   401 unauthorized   404 not_found
 *   405 method_not_allowed   413 body_too_large   415 unsupported_media_type
 *   422 contract_invalid | graph_invalid | xml_unprocessable   500 internal
 *
 * relayoutDiagram NO se expone: cambia posiciones movidas a mano (README).
 * El servicio no guarda nada: cada peticion es pura. Idempotency-Key se ignora.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { generateDiagram, bpmnToContract, updateReferences, GraphValidationError } = require("../dist/index.js");
const { version } = require("../package.json");

const SERVICE = "flu3nce-bpmn-pipeline";
const NODE_TYPES = new Set(["startEvent", "endEvent", "task", "userTask", "serviceTask",
  "exclusiveGateway", "parallelGateway"]);
const MAX_REF_LEN_PX = 1000000;

class ConfigError extends Error {}

class HttpError extends Error {
  constructor(status, code, message, issues) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

// ── Configuracion (solo variables de entorno; ver .env.example) ─────────────

function intOr(raw, dflt, min, max, name) {
  const s = String(raw ?? "").trim();
  if (!s) return dflt;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name}: entero de ${min} a ${max}`);
  return n;
}

function digest(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest();
}

function loadConfig(env) {
  const keys = String(env.DIAGRAMSERVICE_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new ConfigError("DIAGRAMSERVICE_API_KEYS vacia: el servicio no arranca sin clave");
  }
  for (const k of keys) {
    // ASCII visible sin coma (la coma separa claves), como minimo 32 caracteres.
    if (k.length < 32 || !/^[\x21-\x2b\x2d-\x7e]+$/.test(k)) {
      throw new ConfigError("cada clave de DIAGRAMSERVICE_API_KEYS: >= 32 caracteres ASCII visibles, sin comas");
    }
  }
  return {
    keyDigests: keys.map(digest),
    port: intOr(env.PORT, 8080, 1, 65535, "PORT"),
    host: String(env.HOST ?? "").trim() || "0.0.0.0",
    maxBodyBytes: intOr(env.MAX_BODY_BYTES, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024, "MAX_BODY_BYTES"),
  };
}

// ── Autenticacion: X-API-Key contra la lista (rotacion con solape) ──────────

function authorized(req, config) {
  const got = req.headers["x-api-key"];
  if (typeof got !== "string" || got.length === 0) return false;
  const d = digest(got);
  let ok = false;
  // Se comparan todas (sin salir antes) y en tiempo constante.
  for (const k of config.keyDigests) ok = crypto.timingSafeEqual(d, k) || ok;
  return ok;
}

// ── Entrada ─────────────────────────────────────────────────────────────────

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ctype.startsWith("application/json")) {
      reject(new HttpError(415, "unsupported_media_type", "Content-Type debe ser application/json"));
      req.resume();
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "body_too_large", `el cuerpo supera ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, "body_too_large", `el cuerpo supera ${limit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json", "el cuerpo no es JSON valido"));
      }
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.length > 0;

/**
 * Forma minima del Contrato A, para que un JSON roto sea 422 y no un 500.
 * NO sustituye al JSON Schema (src/pipeline/contracts/contract-a.schema.json):
 * no comprueba additionalProperties. La validacion del grafo la hace el paquete.
 */
function contractShapeIssues(c) {
  if (!isObj(c)) return ["contract debe ser un objeto"];
  const issues = [];
  if (c.schemaVersion !== "contrato-a") issues.push('schemaVersion debe ser "contrato-a"');
  if (c.version !== "1.0.0" && c.version !== "2.0.0") issues.push('version debe ser "1.0.0" o "2.0.0"');
  if (!isObj(c.process) || !isStr(c.process.id) || typeof c.process.name !== "string") {
    issues.push("process.id y process.name son obligatorios");
  }
  for (const k of ["lanes", "nodes", "edges"]) {
    if (!Array.isArray(c[k])) issues.push(`${k} debe ser una lista`);
  }
  if (c.dataStores !== undefined && !Array.isArray(c.dataStores)) issues.push("dataStores debe ser una lista");
  if (issues.length) return issues;
  c.lanes.forEach((l, i) => {
    if (!isObj(l) || !isStr(l.id) || typeof l.name !== "string" || !Number.isInteger(l.order)) {
      issues.push(`lanes[${i}]: id, name y order (entero) son obligatorios`);
    }
  });
  c.nodes.forEach((n, i) => {
    if (!isObj(n) || !isStr(n.id) || typeof n.name !== "string" || !isStr(n.lane)) {
      issues.push(`nodes[${i}]: id, type, name y lane son obligatorios`);
    } else if (!NODE_TYPES.has(n.type)) {
      issues.push(`nodes[${i}]: type fuera del vocabulario cerrado: "${String(n.type)}"`);
    }
  });
  c.edges.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.id) || !isStr(e.from) || !isStr(e.to)) {
      issues.push(`edges[${i}]: id, from y to son obligatorios`);
    }
  });
  (c.dataStores ?? []).forEach((s, i) => {
    if (!isObj(s) || !isStr(s.id) || typeof s.name !== "string") issues.push(`dataStores[${i}]: id y name son obligatorios`);
  });
  return issues.slice(0, 50);
}

function refLen(x, name) {
  if (x === undefined || x === null) return 0;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > MAX_REF_LEN_PX) {
    throw new HttpError(400, "invalid_request", `${name} debe ser un numero de 0 a ${MAX_REF_LEN_PX}`);
  }
  return x;
}

function idList(x, name) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || !x.every(isStr)) throw new HttpError(400, "invalid_request", `${name} debe ser una lista de ids`);
  return x;
}

function xmlOf(body) {
  if (!isObj(body) || !isStr(body.xml)) throw new HttpError(400, "invalid_request", "falta xml (string)");
  return body.xml;
}

// ── Rutas ───────────────────────────────────────────────────────────────────

const ROUTES = {
  "/health": {
    GET: async () => ({ status: "ok", service: SERVICE, version }),
  },
  "/generate": {
    POST: async (body) => {
      if (!isObj(body)) throw new HttpError(400, "invalid_request", "el cuerpo debe ser un objeto");
      const issues = contractShapeIssues(body.contract);
      if (issues.length) throw new HttpError(422, "contract_invalid", "Contrato A con forma invalida", issues);
      const options = body.options ?? {};
      if (!isObj(options)) throw new HttpError(400, "invalid_request", "options debe ser un objeto");
      try {
        return await generateDiagram(body.contract, { refMaxLenPx: refLen(options.refMaxLenPx, "options.refMaxLenPx") });
      } catch (e) {
        if (e instanceof GraphValidationError) {
          throw new HttpError(422, "graph_invalid", "Contrato A invalido", e.issues.slice(0, 50));
        }
        throw e; // 500: un fallo del layout o nuestro
      }
    },
  },
  "/to-contract": {
    POST: async (body) => {
      const xml = xmlOf(body);
      try {
        return { contract: await bpmnToContract(xml) };
      } catch (e) {
        throw unprocessable(e);
      }
    },
  },
  "/update-references": {
    POST: async (body) => {
      const xml = xmlOf(body);
      const max = refLen(body.refMaxLenPx, "refMaxLenPx");
      const forceRef = idList(body.forceRef, "forceRef");
      const forceLine = idList(body.forceLine, "forceLine");
      try {
        return await updateReferences(xml, max, forceRef, forceLine);
      } catch (e) {
        throw unprocessable(e);
      }
    },
  },
};

/** Un XML que el paquete no puede leer es del cliente (422), no un 500 a repetir. */
function unprocessable(e) {
  const err = new HttpError(422, "xml_unprocessable", "el BPMN no se pudo procesar");
  err.cause = e;
  return err;
}

// ── Servidor ────────────────────────────────────────────────────────────────

function logLine(o) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
}

function send(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(data);
  return data.length;
}

function createServer(config) {
  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch { /* se queda en "/" y sale 404 */ }
    const cid = String(req.headers["x-correlation-id"] ?? "");
    const entry = { method: req.method, path, correlationId: /^[\w.:-]{1,128}$/.test(cid) ? cid : undefined };
    let status = 500;
    let code;
    let bytes = 0;
    try {
      if (!authorized(req, config)) throw new HttpError(401, "unauthorized", "X-API-Key ausente o no valida");
      const route = ROUTES[path];
      if (!route) throw new HttpError(404, "not_found", "ruta desconocida");
      const handler = route[req.method];
      if (!handler) {
        const err = new HttpError(405, "method_not_allowed", "metodo no admitido");
        err.allow = Object.keys(route).join(", ");
        throw err;
      }
      const body = req.method === "POST" ? await readJson(req, config.maxBodyBytes) : undefined;
      const out = await handler(body);
      status = 200;
      bytes = send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        code = e.code;
        const extra = {};
        if (e.allow) extra.Allow = e.allow;
        if (status === 401) extra["WWW-Authenticate"] = 'ApiKey header="X-API-Key"';
        if (status === 413 || status === 415) extra.Connection = "close";
        if (e.cause) {
          // Solo el tipo: el mensaje puede llevar contenido del proceso.
          entry.cause = e.cause?.name ?? typeof e.cause;
        }
        if (e.issues) entry.issues = e.issues.length; // solo cuantos: llevan datos del cliente
        bytes = send(res, status, { error: e.code, message: e.message, ...(e.issues ? { issues: e.issues } : {}) }, extra);
      } else {
        status = 500;
        code = "internal";
        // Con traza: sin ella no hay diagnostico. Puede llevar ids del proceso.
        process.stderr.write(`[${new Date().toISOString()}] ${req.method} ${path} 500: ${e?.stack ?? e}\n`);
        if (!res.headersSent) bytes = send(res, 500, { error: "internal", message: "error interno del servicio" });
        else res.destroy();
      }
    } finally {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      logLine({ ...entry, status, error: code, ms: Math.round(ms), resBytes: bytes });
    }
  });
  // Tiempos: la cabecera llega rapido; el cuerpo y el calculo pueden tardar
  // (FLU3NCE espera como mucho 120 s por intento, V2_DIAGRAMSERVICE_TIMEOUT_S).
  server.headersTimeout = 20000;
  server.requestTimeout = 130000;
  server.keepAliveTimeout = 65000;
  return server;
}

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    process.stderr.write(`configuracion invalida: ${e.message}\n`);
    process.exit(1);
  }
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    logLine({ event: "listening", service: SERVICE, version, host: config.host, port: config.port,
      keys: config.keyDigests.length });
  });
  const stop = (sig) => {
    logLine({ event: "stopping", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => {
    process.stderr.write(`unhandledRejection: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}

module.exports = { createServer, loadConfig, contractShapeIssues, ConfigError };

if (require.main === module) main();
