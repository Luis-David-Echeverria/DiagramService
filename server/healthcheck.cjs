"use strict";
/**
 * HEALTHCHECK del contenedor: GET http://127.0.0.1:$PORT/health con la primera
 * clave de DIAGRAMSERVICE_API_KEYS. Sale 0 con un 200; 1 en cualquier otro caso.
 * No imprime la clave. SIN EJECUTAR EN LA VM DE FLU3NCE; probar en Hetzner.
 */
const http = require("node:http");

const key = String(process.env.DIAGRAMSERVICE_API_KEYS ?? "").split(",")[0].trim();
const port = Number(String(process.env.PORT ?? "").trim()) || 8080;

const req = http.request(
  { host: "127.0.0.1", port, path: "/health", method: "GET", headers: { "X-API-Key": key }, timeout: 5000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
req.on("error", () => process.exit(1));
req.end();
