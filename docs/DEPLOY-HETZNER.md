# DiagramService en Hetzner

Despliegue del servicio HTTP de `flu3nce-bpmn-pipeline` en un servidor propio de
Hetzner, detrás de Caddy (TLS en 443). Rama `deploy/hetzner`, 1-nov-2026.

> **Estado: sin ejecutar.** Todo lo de esta rama se escribió sin construir ni
> correr nada: en la VM de FLU3NCE no se ejecuta código de terceros. El primer
> `docker build --target test .` y la prueba de humo (§8) se hacen en Hetzner.

## 1. Qué se añade y qué no se toca

| Fichero | Qué es |
|---|---|
| `server/server.cjs` | Servidor HTTP mínimo (solo módulos de Node, sin dependencias nuevas) sobre la API pública del paquete (`dist/index.js`). Incluye la autenticación por `X-API-Key`. |
| `server/healthcheck.cjs` | El HEALTHCHECK del contenedor: `GET /health` en 127.0.0.1 con la clave. |
| `tests/server.cjs` | Pruebas del servidor; entran en `npm test`. |
| `Dockerfile` | Multi-etapa (`build`, `test`, `runtime`), usuario `node` sin privilegios. |
| `docker-compose.yml` | El servicio (puerto interno 8080, sin publicar) y Caddy (443). |
| `deploy/Caddyfile` | TLS con Let's Encrypt, filtro de IP, límite de cuerpo. |
| `.env.example` | Los nombres de las variables, sin valores. |

`src/` no cambia. El servidor está en JavaScript, fuera de `src/`, porque el
`tsconfig.json` no tiene `@types/node` y así no se añade ninguna dependencia.

## 2. La API

Todas las rutas exigen `X-API-Key`, **también `/health`**. Sin clave o con
otra: `401`. Las peticiones son puras: el servicio no guarda nada.
`Idempotency-Key` se acepta y se ignora; `X-Correlation-Id` (si es
`[A-Za-z0-9_.:-]{1,128}`) sale en el log.

| Ruta | Cuerpo | 200 |
|---|---|---|
| `GET /health` | — | `{"status":"ok","service":"flu3nce-bpmn-pipeline","version":"0.1.0"}` |
| `POST /generate` | `{"contract": ContractA, "options": {"refMaxLenPx": n}}` (`options` opcional) | `generateDiagram`: `{xml, warnings[], stats{nodes,edges,lanes}, refs[{code,from,to,lengthPx}], pagination}` |
| `POST /to-contract` | `{"xml": string}` | `{"contract": ContractA}` (siempre `version: "2.0.0"`) |
| `POST /update-references` | `{"xml": string, "refMaxLenPx": n, "forceRef": [id], "forceLine": [id]}` (los tres opcionales) | `updateReferences`: `{xml, pages, refs}` |

`relayoutDiagram` **no** se expone: recalcula la geometría y pierde las
posiciones movidas a mano (ver README).

Errores, siempre `{"error": código, "message": texto, "issues"?: [texto]}`:

| HTTP | `error` | Cuándo | FLU3NCE lo trata como |
|---|---|---|---|
| 400 | `invalid_json`, `invalid_request` | JSON roto, falta `xml`, `refMaxLenPx` fuera de 0..1 000 000 | `internal_error`, sin reintento |
| 401 | `unauthorized` | Sin `X-API-Key` o no válida | `external_not_configured`, sin reintento |
| 403 | (Caddy, sin cuerpo JSON) | IP fuera de `DIAGRAMSERVICE_ALLOWED_IPS` | `external_not_configured`, sin reintento |
| 404 / 405 | `not_found` / `method_not_allowed` | Ruta o método | `internal_error` |
| 413 | `body_too_large` | Más de `MAX_BODY_BYTES` (8 MiB por defecto; Caddy corta en 10 MB) | `diagram_generation_invalid` |
| 415 | `unsupported_media_type` | POST sin `Content-Type: application/json` | `internal_error` |
| 422 | `contract_invalid` | Forma del Contrato A (tipos, campos, vocabulario cerrado) | `diagram_generation_invalid` |
| 422 | `graph_invalid` | `GraphValidationError` del paquete; `issues` = sus `issues` | `diagram_generation_invalid` |
| 422 | `xml_unprocessable` | `to-contract` / `update-references` no pudieron leer el BPMN | `diagram_generation_invalid` |
| 500 | `internal` | Cualquier otro fallo (p. ej. del layout); traza en stderr | `external_failed`, un reintento |

La comprobación de forma del Contrato A es mínima: no aplica el JSON Schema
entero (no rechaza propiedades de más). La del grafo es la del paquete.

**Concurrencia.** Node tiene un solo hilo y el layout es CPU: las peticiones se
atienden de una en una. Mientras se calcula un diagrama grande, `/health`
también espera. Para FLU3NCE (un worker de un hilo) basta; si algún día hay
varios clientes, poner `worker_threads` o varias réplicas.

## 3. Servidor

- **Tamaño:** uno pequeño basta: 2 vCPU x86, 4 GB de RAM, 40 GB de disco
  (gama CX22/CX23 o equivalente), en la ubicación más cercana a FLU3NCE. El
  contenedor tiene un tope de 1 GB y 1,5 CPU (`docker-compose.yml`). Si se elige
  ARM (CAX), la imagen se construye para arm64 y hay que pasar las pruebas allí.
- **Sistema:** Debian 12 o Ubuntu 24.04, actualizaciones de seguridad
  automáticas (`unattended-upgrades`), Docker Engine con el plugin compose.
- **Usuario:** uno sin privilegios en el grupo `docker` para operar; el repo en
  `/opt/diagramservice`.

## 4. Firewall

Usar el **Cloud Firewall de Hetzner** (fuera de la máquina). No fiarse de `ufw`:
Docker publica puertos saltándose sus reglas.

| Entrada | Origen | Por qué |
|---|---|---|
| TCP 443 | cualquiera | Let's Encrypt valida por TLS-ALPN-01 en el 443 desde IP que no se conocen. El filtro por IP lo hace Caddy (§5): solo `DIAGRAMSERVICE_ALLOWED_IPS` llega al servicio. |
| TCP 22 | solo las IP de administración | SSH con clave, `PasswordAuthentication no`, `PermitRootLogin no`. |
| Todo lo demás | — | Cerrado. Ni 80 ni UDP 443 (HTTP/3 desactivado). |

Si se quiere el 443 cerrado a todo salvo FLU3NCE, el certificado tiene que
salir por DNS-01: Caddy con el módulo del proveedor DNS y su token. No está en
esta rama.

## 5. TLS

- Caddy pide y renueva solo un certificado de **Let's Encrypt** para
  `DIAGRAMSERVICE_DOMAIN` (TLS-ALPN-01; HTTP-01 desactivado). Cadena completa.
- TLS 1.2 y 1.3; HSTS. Nada en http: el 80 no se publica, no hay redirección.
- FLU3NCE verifica el certificado y el nombre con el almacén del sistema y no
  sigue redirecciones: el nombre de `V2_DIAGRAMSERVICE_URL` tiene que ser el del
  certificado. No vale uno autofirmado.
- Antes de arrancar: el registro DNS (A, y AAAA si hay IPv6) apuntando al servidor.
- Caddy no escribe access log: el suyo incluye las cabeceras (la clave).

## 6. La clave (`X-API-Key`)

- **Nunca en el repositorio.** Vive en `/opt/diagramservice/.env` (`chmod 600`,
  dueño el operador) y en el servicio `flu3nce-api` de FLU3NCE como
  `DIAGRAMSERVICE_API_KEY`. `.gitignore` y `.dockerignore` excluyen `.env`.
- **Generarla** en el servidor, sin que pase por el historial ni por un chat:
  `openssl rand -hex 32` (64 caracteres). El servicio exige al menos 32 y no
  arranca sin ninguna.
- **Rotarla** cada 90 días y en cuanto haya sospecha. Sin corte, porque
  `DIAGRAMSERVICE_API_KEYS` admite varias separadas por coma:
  1. `DIAGRAMSERVICE_API_KEYS=<nueva>,<vieja>`; `docker compose up -d diagramservice`.
  2. En FLU3NCE, cambiar `DIAGRAMSERVICE_API_KEY` por la nueva (su reinicio sigue
     las reglas de producción de FLU3NCE).
  3. Comprobar §8.2 con la nueva y ver tráfico 200 en el log.
  4. `DIAGRAMSERVICE_API_KEYS=<nueva>`; `docker compose up -d diagramservice`.
  5. Comprobar que la vieja da 401.
- El servicio compara en tiempo constante y nunca escribe la clave en el log.

## 7. Operación

### Instalar

```bash
sudo mkdir -p /opt/diagramservice && sudo chown "$USER" /opt/diagramservice
git clone https://github.com/Luis-David-Echeverria/DiagramService.git /opt/diagramservice
cd /opt/diagramservice && git checkout <sha-aprobado>
cp .env.example .env && chmod 600 .env   # y rellenar los valores en el servidor
docker build --target test .             # npm test dentro de la imagen
docker compose build diagramservice
docker compose up -d
docker compose ps                        # diagramservice "healthy", caddy "running"
```

`DIAGRAMSERVICE_TAG` = el sha corto del commit: cada versión deja su imagen.

### Logs

- `docker compose logs -f diagramservice`: una línea JSON por petición
  (`ts, method, path, correlationId, status, error, ms, resBytes`, y en los 422
  solo cuántos `issues`). Nunca la clave ni el cuerpo. Los 500 escriben su traza
  en stderr (puede llevar ids del proceso).
- `docker compose logs -f caddy`: certificados y errores del proxy.
- Rotación: `json-file`, 5 ficheros de 10 MB por contenedor.

### Actualizar

```bash
cd /opt/diagramservice
git fetch && git checkout <sha-nuevo>
# en .env: DIAGRAMSERVICE_TAG=<sha-nuevo>
docker build --target test .
docker compose build diagramservice
docker compose up -d diagramservice
docker compose ps                        # y después la prueba de humo (§8)
```

Las imágenes `caddy:2` y `node:22-bookworm-slim` se fijan por digest y se suben
a propósito (`NODE_IMAGE` en el Dockerfile).

### Volver atrás

La imagen anterior sigue en el servidor con su etiqueta:

```bash
# en .env: DIAGRAMSERVICE_TAG=<sha-anterior>
git checkout <sha-anterior>
docker compose up -d --no-build diagramservice
```

Conservar las tres últimas (`docker image ls diagramservice`); borrar las más
viejas con `docker image rm diagramservice:<sha>`.

## 8. Prueba de humo (curl)

Desde una IP de `DIAGRAMSERVICE_ALLOWED_IPS`. Sin `-k`: el TLS tiene que pasar
de verdad. La clave va en un fichero de cabeceras, no en la línea de comandos.

```bash
D=https://<DIAGRAMSERVICE_DOMAIN>
umask 077; H=$(mktemp)
read -rs -p "Clave: " K; printf 'X-API-Key: %s\n' "$K" > "$H"; unset K

# 1. Sin clave: 401
curl --proto =https --tlsv1.2 -sS -o /dev/null -w '%{http_code}\n' "$D/health"
# 2. Con clave: 200 {"status":"ok",...}
curl --proto =https --tlsv1.2 -sS -H @"$H" "$D/health"; echo
# 3. Generar con el ejemplo del repo: 200 y un BPMN
jq '{contract: ., options: {refMaxLenPx: 600}}' examples/simple-process.json \
 | curl --proto =https --tlsv1.2 -sS -H @"$H" -H 'Content-Type: application/json' \
        --data-binary @- "$D/generate" | jq '{stats, warnings, refs: (.refs|length), xml: (.xml|.[0:60])}'
# 4. Contrato roto: 422 graph_invalid
curl --proto =https --tlsv1.2 -sS -H @"$H" -H 'Content-Type: application/json' \
     --data-binary '{"contract":{"schemaVersion":"contrato-a","version":"2.0.0","process":{"id":"p","name":"p"},"lanes":[],"nodes":[],"edges":[]}}' \
     -w '\n%{http_code}\n' "$D/generate"
rm -f "$H"
```

Además: desde una IP no autorizada, `/health` da `403`; `curl http://<dominio>`
no conecta; y dentro del servidor
`docker compose exec diagramservice node server/healthcheck.cjs; echo $?` da `0`.

Desde la VM de FLU3NCE (Windows) la comprobación equivalente está en
`docs/diagramservice-hetzner.md` del repo de FLU3NCE (§4).

## 9. Cómo lo llama FLU3NCE

El adaptador es `v2/diagramservice.py` (repo de FLU3NCE). Variables del servicio
`flu3nce-api`:

| Variable | Valor |
|---|---|
| `V2_DIAGRAMSERVICE_URL` | `https://<DIAGRAMSERVICE_DOMAIN>` (sin barra final, sin query) |
| `DIAGRAMSERVICE_API_KEY` | Una de las claves de `DIAGRAMSERVICE_API_KEYS` (sin prefijo `V2_` a propósito) |
| `V2_DIAGRAMSERVICE_TIMEOUT_S` | Segundos por intento, 1 a 120 (30 por defecto). Caddy espera hasta 130 s. |

El adaptador manda `X-API-Key`, `Idempotency-Key` y `X-Correlation-Id` en cada
petición, reintenta una vez los 5xx y los tiempos agotados, nunca un 4xx, y no
sigue redirecciones. Hoy solo llama a `POST /generate`. El interruptor
(`V2_DIAGRAMSERVICE`) y la IP de salida de FLU3NCE para
`DIAGRAMSERVICE_ALLOWED_IPS` se deciden del lado de FLU3NCE.

Lo que afecte a la API pública de FLU3NCE (servir el BPMN al front, códigos de
error nuevos) va en `flu3nce-contract`, no aquí.
