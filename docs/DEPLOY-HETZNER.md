# DiagramService en Hetzner

Despliegue del servicio HTTP de `flu3nce-bpmn-pipeline` en un servidor propio de
Hetzner, detrás de Caddy (TLS en 443, certificado por HTTP-01 en 80). Rama
`deploy/hetzner`, 1-nov-2026.

> **Estado: sin ejecutar.** Todo lo de esta rama se escribió sin construir ni
> correr nada: en la VM de FLU3NCE no se ejecuta código de terceros. El primer
> `docker build --target test .`, el `caddy validate` y la prueba de humo (§8)
> se hacen en Hetzner.

## 1. Qué se añade y qué no se toca

| Fichero | Qué es |
|---|---|
| `server/server.cjs` | Servidor HTTP mínimo (solo módulos de Node, sin dependencias nuevas) sobre la API pública del paquete (`dist/index.js`). Incluye la autenticación por `X-API-Key`. |
| `server/healthcheck.cjs` | El HEALTHCHECK del contenedor: `GET /health` en 127.0.0.1 con la clave. |
| `tests/server.cjs` | Pruebas del servidor; entran en `npm test`. |
| `Dockerfile` | Multi-etapa (`build`, `test`, `runtime`), usuario `node` sin privilegios. |
| `docker-compose.yml` | El servicio (puerto interno 8080, sin publicar) y Caddy (80 y 443). |
| `deploy/Caddyfile` | TLS con Let's Encrypt por HTTP-01, filtro de IP, la clave en el borde, límite de cuerpo. |
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

Errores, siempre `{"error": código, "message": texto, "issues"?: [texto]}`
(también los que responde Caddy):

| HTTP | `error` | Cuándo | FLU3NCE lo trata como |
|---|---|---|---|
| 400 | `invalid_json`, `invalid_request` | JSON roto, falta `xml`, `refMaxLenPx` fuera de 0..1 000 000 | `internal_error`, sin reintento |
| 401 | `unauthorized` | Sin `X-API-Key` o no válida. Lo responde Caddy (en el borde) o, detrás, el servicio: mismo cuerpo | `external_not_configured` (la **clave**), sin reintento |
| 403 | `forbidden` (Caddy) | IP fuera de `DIAGRAMSERVICE_ALLOWED_IPS`. Normalmente ni llega: el firewall corta antes y se ve como tiempo agotado / conexión rechazada | `external_not_configured` (la **IP**), sin reintento |
| 404 / 405 | `not_found` / `method_not_allowed` | Ruta o método | `internal_error` |
| 413 | `body_too_large` | Más de `MAX_BODY_BYTES` (8 MiB por defecto; Caddy corta en 10 MB) | `diagram_generation_invalid` |
| 415 | `unsupported_media_type` | POST sin `Content-Type: application/json` | `internal_error` |
| 422 | `contract_invalid` | Forma del Contrato A (tipos, campos, vocabulario cerrado) | `diagram_generation_invalid` |
| 422 | `graph_invalid` | `GraphValidationError` del paquete; `issues` = sus `issues` | `diagram_generation_invalid` |
| 422 | `xml_unprocessable` | `to-contract` / `update-references` no pudieron leer el BPMN | `diagram_generation_invalid` |
| 500 | `internal` | Cualquier otro fallo (p. ej. del layout); traza en stderr | `external_failed`, un reintento |
| 502 / 504 | (Caddy, sin JSON) | El servicio no responde o tarda más de 130 s | `external_failed` |

Orden de los filtros: firewall (IP) → Caddy IP (403) → Caddy clave (401) →
servicio clave (401) → ruta.

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
| TCP 443 | **solo la IP pública de salida de VMBimcon02** (`/32`) | El servicio. Nadie más llega al TLS. Caddy repite el filtro (403) y además exige la clave (401). |
| TCP 80 | cualquiera (`0.0.0.0/0`, `::/0`) | Solo para el reto HTTP-01 de Let's Encrypt, que valida desde IP que no se conocen. Caddy responde el reto y **404 a todo lo demás**; en el 80 no hay servicio, ni redirección, ni datos. |
| TCP 22 | solo las IP de administración | SSH con clave, `PasswordAuthentication no`, `PermitRootLogin no`. |
| Todo lo demás | — | Cerrado. Ni UDP 443 (HTTP/3 desactivado). |

Salida: libre (Caddy necesita hablar con Let's Encrypt; el contenedor del
servicio está en una red `internal` sin salida).

La misma IP va en el firewall y en `DIAGRAMSERVICE_ALLOWED_IPS`. Si cambia la IP
de salida de VMBimcon02, se cambian las dos; mientras no, FLU3NCE ve tiempos
agotados (firewall) o 403 (Caddy).

## 5. TLS y el certificado (ACME por HTTP-01)

- Caddy pide y renueva solo un certificado de **Let's Encrypt** para
  `DIAGRAMSERVICE_DOMAIN` por **HTTP-01**. TLS-ALPN-01 está desactivado
  (`disable_tlsalpn_challenge`): necesitaría el 443 abierto a la CA.
- El flujo: Caddy pide el certificado → Let's Encrypt hace
  `GET http://<dominio>/.well-known/acme-challenge/<token>` al puerto 80 desde
  varias IP → Caddy lo responde antes de mirar las rutas del bloque `http://`
  (que contesta 404 a lo demás) → se emite el certificado. La renovación (unos
  30 días antes de caducar) repite lo mismo sola; por eso el 80 se queda abierto.
- Si el 80 está cerrado o el DNS no apunta al servidor, no hay certificado: se
  ve en `docker compose logs caddy` (`challenge failed`, `no solvers available`).
- TLS 1.2 y 1.3; HSTS. Cadena completa.
- FLU3NCE verifica el certificado y el nombre con el almacén del sistema y no
  sigue redirecciones: el nombre de `V2_DIAGRAMSERVICE_URL` tiene que ser el del
  certificado. No vale uno autofirmado.
- Antes de arrancar: el registro DNS (A, y AAAA si hay IPv6) apuntando al
  servidor, y el 80 abierto en el firewall.
- Caddy no escribe access log: el suyo incluye las cabeceras (la clave).

## 6. La clave (`X-API-Key`)

La exigen **dos** sitios: Caddy en el borde (401 antes de tocar el servicio) y
el servicio detrás (en tiempo constante). Las dos leen la misma pareja de
variables de `.env`, así que solo hay un sitio que cambiar en el servidor:

| Variable de `.env` | Quién la usa |
|---|---|
| `DIAGRAMSERVICE_API_KEY` | Caddy (matcher `header`) y el servicio (primera de `DIAGRAMSERVICE_API_KEYS`, la del healthcheck) |
| `DIAGRAMSERVICE_API_KEY_PREVIOUS` | Igual. Fuera de una rotación, **la misma** que `DIAGRAMSERVICE_API_KEY` |

Las dos son obligatorias (compose no arranca si falta una): una vacía en Caddy
significaría "cualquier valor".

- **Nunca en el repositorio ni en el Caddyfile.** Vive en
  `/opt/diagramservice/.env` (`chmod 600`, dueño el operador) y en el servicio
  `flu3nce-api` de FLU3NCE como `DIAGRAMSERVICE_API_KEY`. `.gitignore` y
  `.dockerignore` excluyen `.env`.
- **Generarla** en el servidor, sin que pase por el historial ni por un chat:
  `openssl rand -hex 32` (64 caracteres hex). Sin espacios, comas ni `*`.
- **Rotarla** cada 90 días y en cuanto haya sospecha, sin corte:
  1. En `.env`: `DIAGRAMSERVICE_API_KEY=<nueva>`, `DIAGRAMSERVICE_API_KEY_PREVIOUS=<vieja>`.
  2. `docker compose up -d` (recrea **los dos** contenedores: Caddy y el
     servicio aceptan las dos claves).
  3. En FLU3NCE, cambiar `DIAGRAMSERVICE_API_KEY` por la nueva (su reinicio sigue
     las reglas de producción de FLU3NCE).
  4. Comprobar §8 con la nueva y ver tráfico 200 en el log del servicio.
  5. En `.env`: `DIAGRAMSERVICE_API_KEY_PREVIOUS=<nueva>` (igual que la otra);
     `docker compose up -d`.
  6. Comprobar que la vieja da 401.
- Ni Caddy ni el servicio escriben la clave en el log.

## 7. Operación

### Instalar

```bash
sudo mkdir -p /opt/diagramservice && sudo chown "$USER" /opt/diagramservice
git clone https://github.com/Luis-David-Echeverria/DiagramService.git /opt/diagramservice
cd /opt/diagramservice && git checkout <sha-aprobado>
cp .env.example .env && chmod 600 .env   # y rellenar los valores en el servidor
docker build --target test .             # npm test dentro de la imagen
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
docker compose build diagramservice
docker compose up -d
docker compose ps                        # diagramservice "healthy", caddy "running"
docker compose logs caddy | grep -i certificate   # "certificate obtained successfully"
```

`DIAGRAMSERVICE_TAG` = el sha corto del commit: cada versión deja su imagen.

### Logs

- `docker compose logs -f diagramservice`: una línea JSON por petición
  (`ts, method, path, correlationId, status, error, ms, resBytes`, y en los 422
  solo cuántos `issues`). Nunca la clave ni el cuerpo. Los 500 escriben su traza
  en stderr (puede llevar ids del proceso). Los 401/403 que corta Caddy no
  aparecen aquí.
- `docker compose logs -f caddy`: certificados (ACME) y errores del proxy.
- Rotación: `json-file`, 5 ficheros de 10 MB por contenedor.

### Actualizar

```bash
cd /opt/diagramservice
git fetch && git checkout <sha-nuevo>
# en .env: DIAGRAMSERVICE_TAG=<sha-nuevo>
docker build --target test .
docker compose build diagramservice
docker compose up -d                     # recrea Caddy solo si cambió su configuración
docker compose ps                        # y después la prueba de humo (§8)
```

Si cambió `deploy/Caddyfile`: `docker compose run --rm --no-deps caddy caddy
validate --config /etc/caddy/Caddyfile` antes, y `docker compose restart caddy`
después (el fichero va montado, compose no ve el cambio).

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

## 8. Prueba de humo

El 443 solo se abre a VMBimcon02, así que la prueba se parte en dos.

### 8.1 En el servidor de Hetzner (sin clave)

```bash
D=<DIAGRAMSERVICE_DOMAIN>
# El 80 solo sirve el reto: lo demás 404, sin redirección.
curl -sS -o /dev/null -w '%{http_code}\n' "http://$D/"                         # 404
curl -sS -o /dev/null -w '%{http_code}\n' "http://$D/health"                   # 404
# El certificado es de Let's Encrypt y vale para el nombre:
echo | openssl s_client -connect 127.0.0.1:443 -servername "$D" 2>/dev/null \
  | openssl x509 -noout -issuer -subject -enddate
# Desde aquí la IP no está autorizada: 403 de Caddy.
curl -sS --resolve "$D:443:127.0.0.1" -w '\n%{http_code}\n' "https://$D/health" # {"error":"forbidden",...} 403
# El servicio por dentro:
docker compose exec diagramservice node server/healthcheck.cjs; echo $?       # 0
```

Y desde cualquier otra máquina que no sea VMBimcon02: `https://<dominio>` no
conecta (lo corta el firewall).

### 8.2 Desde VMBimcon02 (con clave)

Sin `-k`: el TLS tiene que pasar de verdad. La clave va en un fichero de
cabeceras que se borra al final, no en la línea de comandos. En PowerShell con
`curl.exe` (viene con Windows):

```powershell
$D = 'https://<DIAGRAMSERVICE_DOMAIN>'
$H = New-TemporaryFile
$s = Read-Host -AsSecureString 'Clave'
'X-API-Key: ' + [Net.NetworkCredential]::new('', $s).Password | Set-Content -Encoding ascii $H
Remove-Variable s

curl.exe -sS -o NUL -w "%{http_code}`n" "$D/health"                               # 401 (Caddy)
'X-API-Key: ' + ('0' * 64) | Set-Content -Encoding ascii "$H.mala"
curl.exe -sS -H "@$H.mala" -w "`n%{http_code}`n" "$D/health"; Remove-Item "$H.mala"  # 401 {"error":"unauthorized"}
curl.exe -sS -H "@$H" "$D/health"                                               # 200 {"status":"ok",...}
'{"contract":{"schemaVersion":"contrato-a","version":"2.0.0","process":{"id":"p","name":"p"},"lanes":[],"nodes":[],"edges":[]}}' | Set-Content -Encoding ascii "$H.json"
curl.exe -sS -H "@$H" -H 'Content-Type: application/json' --data-binary "@$H.json" -w "`n%{http_code}`n" "$D/generate"  # 422 graph_invalid
Remove-Item "$H.json", $H
```

Para un 200 de `/generate` con el ejemplo del repo (`examples/simple-process.json`
envuelto en `{"contract": ..., "options": {"refMaxLenPx": 600}}`), o con la
comprobación de FLU3NCE: `docs/diagramservice-hetzner.md` del repo de FLU3NCE.

## 9. Cómo lo llama FLU3NCE

El adaptador es `v2/diagramservice.py` (repo de FLU3NCE). Variables del servicio
`flu3nce-api`:

| Variable | Valor |
|---|---|
| `V2_DIAGRAMSERVICE_URL` | `https://<DIAGRAMSERVICE_DOMAIN>` (sin barra final, sin query) |
| `DIAGRAMSERVICE_API_KEY` | La `DIAGRAMSERVICE_API_KEY` de `.env` (sin prefijo `V2_` a propósito) |
| `V2_DIAGRAMSERVICE_TIMEOUT_S` | Segundos por intento, 1 a 120 (30 por defecto). **Recomendado ≥ 60** para `/generate`: el layout es CPU de un hilo y un proceso grande tarda. Caddy espera hasta 130 s. |

El adaptador manda `X-API-Key`, `Idempotency-Key` y `X-Correlation-Id` en cada
petición, no sigue redirecciones, reintenta una vez los 5xx y nunca un 4xx ni
un tiempo agotado de `/generate` (el servidor seguiría calculando el primero y
el segundo haría cola detrás: un solo hilo). Distingue 401 (la
clave) de 403 (la IP) y lee el campo `error` del cuerpo. Hoy solo llama a
`POST /generate`. El interruptor (`V2_DIAGRAMSERVICE`) y la IP de salida de
VMBimcon02 se deciden del lado de FLU3NCE.

Lo que afecte a la API pública de FLU3NCE (servir el BPMN al front, códigos de
error nuevos) va en `flu3nce-contract`, no aquí.
