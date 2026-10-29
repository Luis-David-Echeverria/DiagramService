/**
 * Conectores off-page (refs (A)...(A)).
 *
 * bpmn-auto-layout produce aristas continuas. Para legibilidad en impresion,
 * toda arista mas larga que un umbral (maxEdgeLengthPx) se reemplaza por un par
 * de marcadores emparejados: en el origen queda "-> (A)" y en el destino
 * "(A) ->". La linea larga desaparece. Un solo criterio: la distancia.
 *
 * Trabaja reescribiendo el DI en memoria (borra el BPMNEdge y agrega dos shapes
 * marcador) usando bpmn:IntermediateThrowEvent/CatchEvent con LinkEventDefinition
 * (el conector off-page oficial de BPMN).
 */

import type { ModdleElement } from 'bpmn-moddle';
import type { DiModel, Point, Bounds } from '../contracts/di';
import { boundsOf, waypointsOf, refId, parseDi, serializeDi } from '../contracts/di';

export interface RefPair {
  /** Letra/codigo del par, ej. "A", "B", ... */
  code: string;
  edgeId: string;
  from: string;
  to: string;
  lengthPx: number;
}

export interface RefsResult {
  enabled: boolean;
  pairs: RefPair[];
}

const MARKER_SIZE = 30;

/** El primer bpmn:Process de las definitions. */
function getProcess(di: DiModel): ModdleElement | undefined {
  const roots = (di.definitions.rootElements as ModdleElement[]) ?? [];
  return roots.find((r) => r.$type === 'bpmn:Process');
}

/** Largo poligonal de una arista sumando sus segmentos. */
function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Genera codigos A, B, ... Z, AA, AB, ... */
function codeFor(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Renumera TODOS los refs del diagrama (A, B, C... en orden de lectura) y
 * actualiza el name "(X)" de ambos eventos de cada par. Es la fuente de verdad
 * de las letras: se llama al final, asi no importa lo que haya pasado con los
 * names al pasar por bpmn-js (import/export). Evita letras repetidas.
 */
export function relabelRefs(di: DiModel): void {
  const proc = getProcess(di);
  const fe = (proc?.flowElements as ModdleElement[]) ?? [];
  const outCenter = new Map<string, number>(); // eid -> x del RefOut (orden lectura)
  for (const s of di.shapes) {
    const m = /^Ref_Out_(.+)$/.exec((s.id as string) ?? '');
    if (m) outCenter.set(m[1]!, boundsOf(s).x);
  }
  // Emparejar por eid a partir de los eventos RefOut_/RefIn_.
  const eids: string[] = [];
  for (const el of fe) {
    const m = /^RefOut_(.+)$/.exec((el.id as string) ?? '');
    if (m) eids.push(m[1]!);
  }
  eids.sort((a, b) => (outCenter.get(a) ?? 0) - (outCenter.get(b) ?? 0));

  const byId = new Map<string, ModdleElement>();
  for (const el of fe) byId.set(el.id as string, el);
  eids.forEach((eid, i) => {
    const label = `(${codeFor(i)})`;
    const out = byId.get(`RefOut_${eid}`);
    const inn = byId.get(`RefIn_${eid}`);
    if (out) out.name = label;
    if (inn) inn.name = label;
  });
}

/**
 * Aplica refs off-page como POST-PROCESO del DI (layout unico, sin re-layout).
 * Quita la linea larga y dibuja la geometria "tubo":
 *   actividad --segmento-- (bolita)  ...sin linea...  (bolita) --segmento-- actividad
 *
 * `cutEdgeIds`: ids de SequenceFlow (Contrato A) a convertir en refs. La decision
 * de cuales se toma afuera (ref-cutter, por distancia/percentil). Muta `di`.
 */
export function applyRefs(di: DiModel, cutEdgeIds: Set<string>): RefsResult {
  if (cutEdgeIds.size === 0) return { enabled: false, pairs: [] };

  const shapeById = new Map<string, ModdleElement>();
  for (const s of di.shapes) shapeById.set(refId(s), s);

  // Cajas ocupadas (nodos, no lanes/pool) para el anti-choque de las bolitas.
  const obstacles: Bounds[] = di.shapes
    .filter((s) => {
      const b = boundsOf(s);
      // Excluir lanes/pool (enormes) por tamano; solo figuras chicas estorban.
      return b.width < 400 && b.height < 250;
    })
    .map(boundsOf);

  // Para ordenar los codigos (A, B, ...) en orden de lectura.
  const centerX = new Map<string, number>();
  for (const s of di.shapes) {
    const b = boundsOf(s);
    centerX.set(refId(s), b.x + b.width / 2);
  }

  const candidates: { edge: ModdleElement; pair: Omit<RefPair, 'code'> }[] = [];
  for (const edge of di.edges) {
    if (!cutEdgeIds.has(refId(edge))) continue;
    const src = (edge.bpmnElement as ModdleElement)?.sourceRef as ModdleElement | undefined;
    const tgt = (edge.bpmnElement as ModdleElement)?.targetRef as ModdleElement | undefined;
    const from = (src?.id as string) ?? '';
    const to = (tgt?.id as string) ?? '';
    if (!from || !to) continue;
    candidates.push({
      edge,
      pair: { edgeId: refId(edge), from, to, lengthPx: polylineLength(waypointsOf(edge)) },
    });
  }

  // Ordenar por posicion del origen (lectura) para que las letras salgan en
  // orden razonable.
  candidates.sort(
    (a, b) => (centerX.get(a.pair.from) ?? 0) - (centerX.get(b.pair.from) ?? 0),
  );

  const planeElements = di.plane.planeElement as ModdleElement[];
  const proc = getProcess(di);
  const flowElements = (proc?.flowElements as ModdleElement[]) ?? [];
  const pairs: RefPair[] = [];
  // Las bolitas ya colocadas tambien son obstaculos para las siguientes.
  const placedMarkers: Bounds[] = [];

  // Letras YA usadas por refs existentes (para no repetir al agregar refs de
  // forma incremental). Se leen del name "(X)" de los RefOut existentes.
  const usedCodes = new Set<string>();
  for (const el of flowElements) {
    if (/^RefOut_/.test((el.id as string) ?? '')) {
      const m = /^\((.+)\)$/.exec((el.name as string) ?? '');
      if (m) usedCodes.add(m[1]!);
    }
  }
  let codeIdx = 0;
  const allocCode = (): string => {
    let c = codeFor(codeIdx++);
    while (usedCodes.has(c)) c = codeFor(codeIdx++);
    usedCodes.add(c);
    return c;
  };

  candidates.forEach((cand) => {
    const code = allocCode();
    const { edge, pair } = cand;
    const eid = pair.edgeId; // id de la arista original (para poder mapear/revertir)

    const srcShape = shapeById.get(pair.from)!;
    const tgtShape = shapeById.get(pair.to)!;

    // Geometria "tubo":
    //   actividad --segmento(s)-- (bolita)  ...sin linea...  (bolita) --segmento(s)-- actividad
    // La bolita CAMINA por la TRAYECTORIA ortogonal real (recta o codos), desde
    // una distancia minima, hasta el primer punto donde CABE sin chocar.
    const wps = waypointsOf(edge);

    // Origen: desde el inicio de la linea hacia adelante.
    const outPlace = placeMarker(wps, false, obstacles, placedMarkers);
    // Destino: desde el final de la linea hacia atras.
    const inPlace = placeMarker(wps, true, obstacles, placedMarkers);
    const outMarkerCenter = outPlace.center;
    const inMarkerCenter = inPlace.center;

    // Registrar las bolitas como obstaculos para las siguientes refs.
    placedMarkers.push(markerBounds(outMarkerCenter), markerBounds(inMarkerCenter));

    // 1. Quitar el BPMNEdge original del plano (la linea larga desaparece).
    const idxDi = planeElements.indexOf(edge);
    if (idxDi !== -1) planeElements.splice(idxDi, 1);

    // 2. Quitar el SequenceFlow original del proceso y descablearlo de los
    //    nodos, para re-cablear a traves de los marcadores.
    const origFlow = edge.bpmnElement as ModdleElement;
    removeFlowElement(flowElements, origFlow);
    detachFlow(srcShape.bpmnElement as ModdleElement, origFlow, 'outgoing');
    detachFlow(tgtShape.bpmnElement as ModdleElement, origFlow, 'incoming');

    // 3. Link Events (conector off-page oficial de BPMN): throw = sale, catch =
    //    entra, emparejados por el mismo link name. Los ids incrustan el edgeId
    //    original para poder identificar/revertir el ref desde el editor.
    const linkName = `Link_${eid}`;
    const throwEvent = di.moddle.create('bpmn:IntermediateThrowEvent', {
      id: `RefOut_${eid}`,
      name: `(${code})`,
      eventDefinitions: [
        di.moddle.create('bpmn:LinkEventDefinition', { id: `LinkDefOut_${eid}`, name: linkName }),
      ],
    });
    const catchEvent = di.moddle.create('bpmn:IntermediateCatchEvent', {
      id: `RefIn_${eid}`,
      name: `(${code})`,
      eventDefinitions: [
        di.moddle.create('bpmn:LinkEventDefinition', { id: `LinkDefIn_${eid}`, name: linkName }),
      ],
    });
    flowElements.push(throwEvent, catchEvent);

    // 4. Re-cablear semanticamente: origen -> RefOut, y RefIn -> destino.
    const flowToRef = di.moddle.create('bpmn:SequenceFlow', {
      id: `Flow_toRef_${eid}`,
      sourceRef: srcShape.bpmnElement,
      targetRef: throwEvent,
    });
    const flowFromRef = di.moddle.create('bpmn:SequenceFlow', {
      id: `Flow_fromRef_${eid}`,
      sourceRef: catchEvent,
      targetRef: tgtShape.bpmnElement,
    });
    flowElements.push(flowToRef, flowFromRef);
    attachFlow(srcShape.bpmnElement as ModdleElement, flowToRef, 'outgoing');
    attachFlow(throwEvent, flowToRef, 'incoming');
    attachFlow(catchEvent, flowFromRef, 'outgoing');
    attachFlow(tgtShape.bpmnElement as ModdleElement, flowFromRef, 'incoming');

    // 5. Shapes DI de los marcadores.
    const outMarker = di.moddle.create('bpmndi:BPMNShape', {
      id: `Ref_Out_${eid}`,
      bpmnElement: throwEvent,
      bounds: di.moddle.create('dc:Bounds', {
        x: outMarkerCenter.x - MARKER_SIZE / 2,
        y: outMarkerCenter.y - MARKER_SIZE / 2,
        width: MARKER_SIZE,
        height: MARKER_SIZE,
      }),
    });
    const inMarker = di.moddle.create('bpmndi:BPMNShape', {
      id: `Ref_In_${eid}`,
      bpmnElement: catchEvent,
      bounds: di.moddle.create('dc:Bounds', {
        x: inMarkerCenter.x - MARKER_SIZE / 2,
        y: inMarkerCenter.y - MARKER_SIZE / 2,
        width: MARKER_SIZE,
        height: MARKER_SIZE,
      }),
    });
    planeElements.push(outMarker, inMarker);
    di.shapes.push(outMarker, inMarker);

    // 6. Segmentos (el tubo): la polilinea ortogonal caja->bolita que devolvio
    //    placeMarker, con el ultimo punto llevado al BORDE de la bolita (para
    //    que la flecha toque el circulo, no su centro).
    //    origen:  caja --flecha--> (bolita)   [flecha apunta a la bolita]
    //    destino: (bolita) --flecha--> caja   [flecha apunta a la actividad]
    const outSeg = toBorder(outPlace.path, outMarkerCenter); // termina en la bolita
    const inSeg = toBorder(inPlace.path, inMarkerCenter).reverse(); // bolita -> caja
    planeElements.push(
      shortEdge(di, `Edge_toRef_${eid}`, flowToRef, outSeg),
      shortEdge(di, `Edge_fromRef_${eid}`, flowFromRef, inSeg),
    );

    pairs.push({ code, ...pair });
  });

  return { enabled: true, pairs };
}

// ── helpers de geometria y cableado ──────────────────────────────────────────

/** Distancia minima desde la caja a la que arranca la bolita (no pegada). */
const MIN_WALK = 52;
/** Al cruzar un codo, avanzar al menos esto por el nuevo segmento (glue limpio). */
const MIN_PAST_ELBOW = 30;
/** Paso del "caminado" por la linea al buscar hueco. */
const WALK_STEP = 10;

/** Bounds del marcador (bolita) centrado en un punto. */
function markerBounds(center: Point): Bounds {
  return {
    x: center.x - MARKER_SIZE / 2,
    y: center.y - MARKER_SIZE / 2,
    width: MARKER_SIZE,
    height: MARKER_SIZE,
  };
}

/** True si dos rectangulos se solapan (con un margen de respiro). */
function overlaps(a: Bounds, b: Bounds, pad = 4): boolean {
  return (
    a.x - pad < b.x + b.width &&
    a.x + a.width + pad > b.x &&
    a.y - pad < b.y + b.height &&
    a.y + a.height + pad > b.y
  );
}

export interface Placement {
  center: Point;
  /** Ruta ORTOGONAL desde el borde de la caja hasta el centro de la bolita. */
  path: Point[];
}

/**
 * Coloca una bolita caminando por la TRAYECTORIA ortogonal real de la linea
 * (recta o codos, nunca diagonal). Avanza por el primer segmento; si no cabe,
 * cruza el codo (empezando MIN_PAST_ELBOW despues de la esquina, para que el
 * glue quede por el lado correcto) y sigue por el segmento siguiente. El
 * resultado conserva la forma de codo, con el ultimo tramo mas corto.
 *
 * @param wps       waypoints de la linea original (ortogonales).
 * @param fromEnd   true = lado destino (recorre la linea desde el final).
 * @param obstacles cajas de figuras.
 * @param placed    bolitas ya colocadas.
 * @returns centro de la bolita + la polilinea ortogonal caja->bolita.
 */
function placeMarker(
  wps: Point[],
  fromEnd: boolean,
  obstacles: Bounds[],
  placed: Bounds[],
): Placement {
  const path = fromEnd ? [...wps].reverse() : [...wps];
  if (path.length === 0) return { center: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }] };
  if (path.length === 1) return { center: path[0]!, path: [path[0]!] };

  const box = path[0]!;
  // Esquinas ya recorridas (los codos que cruzamos), arrancando en la caja.
  const corners: Point[] = [box];

  const free = (p: Point): boolean => {
    const cand = markerBounds(p);
    return !obstacles.some((o) => overlaps(cand, o)) && !placed.some((o) => overlaps(cand, o));
  };

  for (let seg = 1; seg < path.length; seg++) {
    const a = path[seg - 1]!;
    const b = path[seg]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1) {
      corners.push(b);
      continue;
    }
    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;
    // Offset inicial: en el 1er segmento, MIN_WALK desde la caja; tras un codo,
    // MIN_PAST_ELBOW desde la esquina.
    const startOff = seg === 1 ? MIN_WALK : MIN_PAST_ELBOW;
    for (let d = startOff; d <= segLen; d += WALK_STEP) {
      const p = { x: a.x + ux * d, y: a.y + uy * d };
      if (free(p)) return { center: p, path: [...corners, p] };
    }
    // Segmento entero ocupado -> registrar el codo y seguir.
    corners.push(b);
  }

  // Nada libre en toda la ruta: colocar cerca del final del ultimo segmento.
  const last = path[path.length - 1]!;
  const prev = path[path.length - 2]!;
  const segLen = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
  const back = Math.min(MIN_PAST_ELBOW, segLen / 2);
  const p = {
    x: last.x - ((last.x - prev.x) / segLen) * back,
    y: last.y - ((last.y - prev.y) / segLen) * back,
  };
  return { center: p, path: [...corners.slice(0, -1), p] };
}

/**
 * Punto en el BORDE del marcador (circulo de radio MARKER_SIZE/2) en direccion
 * a `toward`. Asi la flechita termina tocando el circulo, no en su centro.
 */
function markerBorder(center: Point, toward: Point): Point {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const dist = Math.hypot(dx, dy) || 1;
  const r = MARKER_SIZE / 2;
  return { x: center.x + (dx / dist) * r, y: center.y + (dy / dist) * r };
}

/** Crea un BPMNEdge DI con dos waypoints (la flechita corta). */
function shortEdge(
  di: DiModel,
  id: string,
  flow: ModdleElement,
  points: Point[],
): ModdleElement {
  return di.moddle.create('bpmndi:BPMNEdge', {
    id,
    bpmnElement: flow,
    waypoint: orthogonalize(points).map((p) =>
      di.moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }),
    ),
  });
}

/**
 * Toma una ruta ortogonal [caja, ...codos, centroBolita] y reemplaza el ultimo
 * punto (el centro) por el BORDE de la bolita, para que la flecha toque el
 * circulo y no lo atraviese. Conserva los codos intactos (ortogonalidad).
 */
function toBorder(path: Point[], center: Point): Point[] {
  if (path.length < 2) return [center];
  const prev = path[path.length - 2]!;
  const out = path.slice(0, -1);
  out.push(markerBorder(center, prev));
  return out;
}

function removeFlowElement(list: ModdleElement[], el: ModdleElement): void {
  const i = list.indexOf(el);
  if (i !== -1) list.splice(i, 1);
}

function attachFlow(node: ModdleElement, flow: ModdleElement, dir: 'incoming' | 'outgoing'): void {
  ((node[dir] ??= []) as ModdleElement[]).push(flow);
}

function detachFlow(node: ModdleElement, flow: ModdleElement, dir: 'incoming' | 'outgoing'): void {
  const arr = node[dir] as ModdleElement[] | undefined;
  if (!arr) return;
  const i = arr.indexOf(flow);
  if (i !== -1) arr.splice(i, 1);
}

/**
 * Revierte los refs a lineas: quita los Link Events y sus flows-segmento, y
 * restaura la SequenceFlow original (mismo id y label) entre origen y destino.
 * Devuelve BPMN semantico limpio (sin DI: el layouter la regenera). Es la
 * inversa de applyRefs, para poder layoutear SIN las bolitas metidas.
 */
export async function stripRefs(xml: string): Promise<string> {
  const di = await parseDi(xml);
  const proc = getProcess(di);
  const fe = (proc?.flowElements as ModdleElement[]) ?? [];
  const byId = new Map<string, ModdleElement>();
  for (const el of fe) byId.set(el.id as string, el);

  // edgeIds que estan como ref (por el marcador de salida RefOut_<edgeId>).
  const edgeIds = new Set<string>();
  for (const el of fe) {
    const m = /^RefOut_(.+)$/.exec((el.id as string) ?? '');
    if (m) edgeIds.add(m[1]!);
  }

  for (const eid of edgeIds) {
    const throwEv = byId.get(`RefOut_${eid}`);
    const catchEv = byId.get(`RefIn_${eid}`);
    const fTo = byId.get(`Flow_toRef_${eid}`);
    const fFrom = byId.get(`Flow_fromRef_${eid}`);
    if (!throwEv || !catchEv || !fTo || !fFrom) continue;

    const source = fTo.sourceRef as ModdleElement;
    const target = fFrom.targetRef as ModdleElement;

    // Descablear los flows-segmento de las cajas.
    detachFlow(source, fTo, 'outgoing');
    detachFlow(target, fFrom, 'incoming');
    // Quitar Link Events + flows-segmento del proceso.
    for (const el of [throwEv, catchEv, fTo, fFrom]) removeFlowElement(fe, el);

    // Restaurar la linea original (id y label del edge de Contrato A).
    const line = di.moddle.create('bpmn:SequenceFlow', {
      id: eid,
      name: (fTo.name as string) || undefined,
      sourceRef: source,
      targetRef: target,
    });
    fe.push(line);
    attachFlow(source, line, 'outgoing');
    attachFlow(target, line, 'incoming');
  }

  // Limpiar el DI: el layouter regenera geometria desde cero.
  (di.definitions as ModdleElement).diagrams = [];
  return serializeDi(di);
}

/** Quita puntos consecutivos repetidos de una polilinea. */
function dedupe(pts: Point[]): Point[] {
  return pts.filter(
    (p, i) => i === 0 || Math.abs(p.x - pts[i - 1]!.x) > 0.5 || Math.abs(p.y - pts[i - 1]!.y) > 0.5,
  );
}

/**
 * Simplifica una polilinea ORTOGONAL: elimina puntos colineales y PICOS (dos
 * segmentos seguidos sobre el mismo eje = la linea vuelve sobre si misma). Si
 * dos tramos consecutivos son del mismo eje (ambos horizontales o ambos
 * verticales), el punto del medio sobra -> se quita. Itera hasta estabilizar.
 */
function simplifyOrtho(pts: Point[]): Point[] {
  let p = dedupe(pts);
  let changed = true;
  while (changed && p.length > 2) {
    changed = false;
    const out: Point[] = [];
    for (let i = 0; i < p.length; i++) {
      if (i > 0 && i < p.length - 1) {
        const a = out[out.length - 1] ?? p[i - 1]!;
        const b = p[i]!;
        const c = p[i + 1]!;
        const abH = Math.abs(a.y - b.y) < 1;
        const abV = Math.abs(a.x - b.x) < 1;
        const bcH = Math.abs(b.y - c.y) < 1;
        const bcV = Math.abs(b.x - c.x) < 1;
        // Mismo eje en ambos tramos => b sobra (colineal o pico).
        if ((abH && bcH) || (abV && bcV)) { changed = true; continue; }
      }
      out.push(p[i]!);
    }
    p = dedupe(out);
  }
  return p;
}

/** True si un segmento ortogonal (a-b) atraviesa un rectangulo (con padding). */
function segHitsRect(a: Point, b: Point, r: Bounds, pad = 6): boolean {
  const rx1 = r.x - pad, ry1 = r.y - pad, rx2 = r.x + r.width + pad, ry2 = r.y + r.height + pad;
  if (Math.abs(a.y - b.y) < 1) {
    const y = a.y, xmin = Math.min(a.x, b.x), xmax = Math.max(a.x, b.x);
    return y > ry1 && y < ry2 && xmax > rx1 && xmin < rx2;
  }
  const x = a.x, ymin = Math.min(a.y, b.y), ymax = Math.max(a.y, b.y);
  return x > rx1 && x < rx2 && ymax > ry1 && ymin < ry2;
}

/**
 * Garantiza que la polilinea sea ORTOGONAL (solo tramos horizontales o
 * verticales, 90 grados entre segmentos). Donde dos puntos difieran en ambos
 * ejes, inserta un codo. Continua el eje del tramo previo para que se vea
 * natural. Defensivo: si ya es ortogonal, no cambia nada.
 */
function orthogonalize(pts: Point[]): Point[] {
  if (pts.length < 2) return pts;
  const out: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    if (Math.abs(b.x - a.x) > 1 && Math.abs(b.y - a.y) > 1) {
      const prev = out.length >= 2 ? out[out.length - 2]! : null;
      const prevHoriz = prev
        ? Math.abs(a.y - prev.y) < 1
        : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      out.push(prevHoriz ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    }
    out.push(b);
  }
  return dedupe(out);
}

/** Vector unitario sobre el eje dominante de a->b (siempre axis-aligned). */
function unitAxis(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx) || 1, y: 0 }
    : { x: 0, y: Math.sign(dy) || 1 };
}

/**
 * Router A* ORTOGONAL sobre grilla de Hanan (lineas por los bordes de las cajas
 * + margen). Encuentra la ruta mas corta de srcGlue a tgtGlue que NO cruza
 * ninguna caja, minimizando codos (penalizacion por giro). Respeta el lado de
 * salida/entrada via los puntos de escape. Devuelve la polilinea o null si no
 * hay ruta.
 */
function routeAStar(
  srcGlue: Point,
  exitDir: Point,
  tgtGlue: Point,
  entryDir: Point,
  allObstacles: Bounds[],
): Point[] | null {
  // Puntos de escape: salir/entrar por el lado correcto. Si caen dentro de una
  // caja (vecina pegada), se corrigen abajo.
  const M = 24;
  let s = { x: srcGlue.x + exitDir.x * M, y: srcGlue.y + exitDir.y * M };
  let t = { x: tgtGlue.x - entryDir.x * M, y: tgtGlue.y - entryDir.y * M };
  const inside = (p: Point) =>
    allObstacles.some((o) => p.x > o.x && p.x < o.x + o.width && p.y > o.y && p.y < o.y + o.height);
  if (inside(s)) s = srcGlue; // escape dentro de una caja -> arrancar en el glue
  if (inside(t)) t = tgtGlue;

  // Solo obstaculos cercanos a la region s-t (pruning).
  const minX = Math.min(s.x, t.x) - 80, maxX = Math.max(s.x, t.x) + 80;
  const minY = Math.min(s.y, t.y) - 80, maxY = Math.max(s.y, t.y) + 80;
  const obstacles = allObstacles.filter(
    (o) => o.x < maxX && o.x + o.width > minX && o.y < maxY && o.y + o.height > minY,
  );

  const PAD = 8;
  const xset = new Set<number>([s.x, t.x, minX, maxX]);
  const yset = new Set<number>([s.y, t.y, minY, maxY]);
  for (const o of obstacles) {
    xset.add(o.x - PAD); xset.add(o.x + o.width + PAD);
    yset.add(o.y - PAD); yset.add(o.y + o.height + PAD);
  }
  const X = [...xset].sort((a, b) => a - b);
  const Y = [...yset].sort((a, b) => a - b);
  const W = X.length, Hh = Y.length;
  if (W * Hh > 90000) return null; // demasiado grande, usar fallback
  const xiOf = new Map(X.map((v, i) => [v, i] as const));
  const yiOf = new Map(Y.map((v, i) => [v, i] as const));
  const sX = xiOf.get(s.x)!, sY = yiOf.get(s.y)!, tX = xiOf.get(t.x)!, tY = yiOf.get(t.y)!;

  const hitsH = (xi1: number, xi2: number, yi: number): boolean => {
    const a = { x: X[Math.min(xi1, xi2)]!, y: Y[yi]! };
    const b = { x: X[Math.max(xi1, xi2)]!, y: Y[yi]! };
    return obstacles.some((o) => segHitsRect(a, b, o, 0));
  };
  const hitsV = (yi1: number, yi2: number, xi: number): boolean => {
    const a = { x: X[xi]!, y: Y[Math.min(yi1, yi2)]! };
    const b = { x: X[xi]!, y: Y[Math.max(yi1, yi2)]! };
    return obstacles.some((o) => segHitsRect(a, b, o, 0));
  };

  const TURN = 40; // penalizacion por codo
  const key = (xi: number, yi: number, ax: number) => (ax * Hh + yi) * W + xi;
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  // Heap binario minimo por f.
  const heap: Array<{ k: number; f: number }> = [];
  const push = (k: number, f: number) => {
    heap.push({ k, f });
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p]!.f <= heap[i]!.f) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l]!.f < heap[m]!.f) m = l; if (r < heap.length && heap[r]!.f < heap[m]!.f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; } }
    return top;
  };
  const heur = (xi: number, yi: number) => Math.abs(X[xi]! - t.x) + Math.abs(Y[yi]! - t.y);

  const start = key(sX, sY, 0);
  gScore.set(start, 0);
  push(start, heur(sX, sY));
  let goalKey = -1;

  while (heap.length) {
    const { k } = pop();
    const ax = Math.floor(k / (W * Hh));
    const rem = k % (W * Hh);
    const yi = Math.floor(rem / W);
    const xi = rem % W;
    const g = gScore.get(k)!;
    if (xi === tX && yi === tY) { goalKey = k; break; }

    const moves: Array<[number, number, number]> = [];
    if (xi + 1 < W && !hitsH(xi, xi + 1, yi)) moves.push([xi + 1, yi, 1]);
    if (xi - 1 >= 0 && !hitsH(xi, xi - 1, yi)) moves.push([xi - 1, yi, 1]);
    if (yi + 1 < Hh && !hitsV(yi, yi + 1, xi)) moves.push([xi, yi + 1, 2]);
    if (yi - 1 >= 0 && !hitsV(yi, yi - 1, xi)) moves.push([xi, yi - 1, 2]);
    for (const [nx, ny, nax] of moves) {
      const step = Math.abs(X[nx]! - X[xi]!) + Math.abs(Y[ny]! - Y[yi]!);
      const turn = ax !== 0 && ax !== nax ? TURN : 0;
      const ng = g + step + turn;
      const nk = key(nx, ny, nax);
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        cameFrom.set(nk, k);
        push(nk, ng + heur(nx, ny));
      }
    }
  }
  if (goalKey < 0) return null;

  // Reconstruir.
  const pts: Point[] = [];
  let cur: number | undefined = goalKey;
  while (cur !== undefined) {
    const rem = cur % (W * Hh);
    pts.push({ x: X[rem % W]!, y: Y[Math.floor(rem / W)]! });
    cur = cameFrom.get(cur);
  }
  pts.reverse();
  return simplifyOrtho([srcGlue, ...pts, tgtGlue]);
}

/**
 * Rutea una linea ortogonal de srcGlue a tgtGlue conservando los lados de
 * salida/entrada (exitDir/entryDir) y ESQUIVANDO las cajas `obstacles`. Usa A*
 * (optimo, sin cruces); si no encuentra o la grilla es enorme, cae a codos en
 * L / canales en Z. Siempre ortogonal y sin picos.
 */
function routeAroundBoxes(
  srcGlue: Point,
  exitDir: Point,
  tgtGlue: Point,
  entryDir: Point,
  obstacles: Bounds[],
): Point[] {
  // Primero A* (optimo, esquiva figuras). Si encuentra ruta, se usa.
  const astar = routeAStar(srcGlue, exitDir, tgtGlue, entryDir, obstacles);
  if (astar) return astar;

  // Fallback: codos en L / canales en Z.
  const M = 26;
  const sEsc = { x: srcGlue.x + exitDir.x * M, y: srcGlue.y + exitDir.y * M };
  const tEsc = { x: tgtGlue.x - entryDir.x * M, y: tgtGlue.y - entryDir.y * M };

  const clean = (mids: Point[]): Point[] =>
    simplifyOrtho(orthogonalize([srcGlue, sEsc, ...mids, tEsc, tgtGlue]));
  const hits = (pts: Point[]): boolean => {
    for (let i = 0; i < pts.length - 1; i++) {
      if (obstacles.some((o) => segHitsRect(pts[i]!, pts[i + 1]!, o))) return true;
    }
    return false;
  };

  const candidates: Point[][] = [
    clean([{ x: tEsc.x, y: sEsc.y }]), // L: horizontal luego vertical
    clean([{ x: sEsc.x, y: tEsc.y }]), // L: vertical luego horizontal
  ];
  // Canales en Z: barrer una vertical intermedia y una horizontal intermedia.
  for (let f = 1; f <= 8; f++) {
    const t = f / 9;
    const mx = sEsc.x + (tEsc.x - sEsc.x) * t;
    const my = sEsc.y + (tEsc.y - sEsc.y) * t;
    candidates.push(clean([{ x: mx, y: sEsc.y }, { x: mx, y: tEsc.y }])); // canal vertical
    candidates.push(clean([{ x: sEsc.x, y: my }, { x: tEsc.x, y: my }])); // canal horizontal
  }
  // Ultimo recurso: rodear TODO el campo de obstaculos por alguno de los 4 lados.
  if (obstacles.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of obstacles) {
      minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.width); maxY = Math.max(maxY, o.y + o.height);
    }
    const G = 30;
    for (const chX of [maxX + G, minX - G]) {
      candidates.push(clean([{ x: chX, y: sEsc.y }, { x: chX, y: tEsc.y }]));
    }
    for (const chY of [maxY + G, minY - G]) {
      candidates.push(clean([{ x: sEsc.x, y: chY }, { x: tEsc.x, y: chY }]));
    }
  }
  for (const c of candidates) if (!hits(c)) return c;
  return candidates[0]!; // best-effort
}

/**
 * Re-rutea toda LINEA (SequenceFlow) cuyo trazo cruce alguna figura.
 *
 * bpmn-auto-layout a veces rutea una arista con un rodeo largo que ATRAVIESA
 * cajas (aunque origen y destino esten cerca). Como esas lineas no son refs,
 * nunca las tocabamos y el cruce quedaba. Aca, sobre el DI ya con refs
 * aplicadas, detectamos las que cruzan y las reemplazamos por la ruta A*
 * (esquiva figuras), conservando por que lado salen y entran. Ortogonal, sin
 * picos. No toca los segmentos de refs (bolitas).
 */
export function rerouteCrossingLines(di: DiModel): void {
  const planeEls = di.plane.planeElement as ModdleElement[];
  const figs = planeEls
    .filter((e) => e.$type === 'bpmndi:BPMNShape')
    .map((s) => ({ id: refId(s), b: boundsOf(s) }))
    .filter((f) => f.b.width < 400 && f.b.height < 250);

  const crosses = (pts: Point[], fromId: string, toId: string): boolean => {
    for (let i = 0; i < pts.length - 1; i++) {
      for (const f of figs) {
        if (f.id === fromId || f.id === toId) continue;
        if (segHitsRect(pts[i]!, pts[i + 1]!, f.b)) return true;
      }
    }
    return false;
  };

  for (const edge of planeEls.filter((e) => e.$type === 'bpmndi:BPMNEdge')) {
    const id = (edge.id as string) ?? '';
    if (id.startsWith('Edge_toRef_') || id.startsWith('Edge_fromRef_')) continue; // ref, no
    const bo = edge.bpmnElement as ModdleElement | undefined;
    if (!bo || bo.$type !== 'bpmn:SequenceFlow') continue;
    const wps = waypointsOf(edge);
    if (wps.length < 2) continue;
    const fromId = ((bo.sourceRef as ModdleElement | undefined)?.id as string) ?? '';
    const toId = ((bo.targetRef as ModdleElement | undefined)?.id as string) ?? '';
    if (!crosses(wps, fromId, toId)) continue;

    const exitDir = unitAxis(wps[0]!, wps[1]!);
    const entryDir = unitAxis(wps[wps.length - 2]!, wps[wps.length - 1]!);
    // Incluir TODAS las figuras como obstaculos, tambien source/target: la linea
    // sale/entra por los puntos de escape (24px afuera), asi no corta su interior.
    const obst = figs.map((f) => f.b);
    const nw = routeAroundBoxes(wps[0]!, exitDir, wps[wps.length - 1]!, entryDir, obst);
    edge.waypoint = nw.map((p) =>
      di.moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }),
    ) as unknown as ModdleElement[];
  }
}

/**
 * Ortogonaliza (y, si cruzan figuras, re-rutea con A*) las asociaciones de datos
 * — las líneas punteadas de los tambores (DataInput/OutputAssociation). Misma
 * lógica que las refs: ortogonal, sin picos, esquivando cajas. bpmn-auto-layout
 * a veces las traza en diagonal; aquí quedan en ángulo recto y sin cruzar nada.
 */
export function orthogonalizeDataAssociations(di: DiModel): void {
  const planeEls = di.plane.planeElement as ModdleElement[];
  const figs = planeEls
    .filter((e) => e.$type === 'bpmndi:BPMNShape')
    .map((s) => ({ id: refId(s), b: boundsOf(s) }))
    .filter((f) => f.b.width < 400 && f.b.height < 250);

  // Dueño (actividad) y store de cada asociación, desde el semántico, para no
  // tratarlos como obstáculos de su propia línea.
  const proc = getProcess(di);
  const fe = (proc?.flowElements as ModdleElement[]) ?? [];
  const endpointsOf = new Map<string, Set<string>>(); // assocId -> {activityId, storeId}
  const register = (act: ModdleElement, assoc: ModdleElement, store?: ModdleElement) => {
    const set = new Set<string>([act.id as string]);
    if (store) set.add(store.id as string);
    endpointsOf.set(assoc.id as string, set);
  };
  for (const act of fe) {
    for (const a of ((act.dataInputAssociations as ModdleElement[]) ?? [])) {
      register(act, a, ((a.sourceRef as ModdleElement[]) ?? [])[0]);
    }
    for (const a of ((act.dataOutputAssociations as ModdleElement[]) ?? [])) {
      register(act, a, a.targetRef as ModdleElement | undefined);
    }
  }

  const isAssoc = (t?: string) =>
    t === 'bpmn:DataInputAssociation' || t === 'bpmn:DataOutputAssociation';
  const crosses = (pts: Point[], exclude: Set<string>): boolean => {
    for (let i = 0; i < pts.length - 1; i++) {
      for (const f of figs) {
        if (exclude.has(f.id)) continue;
        if (segHitsRect(pts[i]!, pts[i + 1]!, f.b)) return true;
      }
    }
    return false;
  };

  for (const edge of planeEls.filter((e) => e.$type === 'bpmndi:BPMNEdge')) {
    const bo = edge.bpmnElement as ModdleElement | undefined;
    if (!bo || !isAssoc(bo.$type as string)) continue;
    const wps = waypointsOf(edge);
    if (wps.length < 2) continue;
    const exclude = endpointsOf.get(bo.id as string) ?? new Set<string>();

    let nw = simplifyOrtho(orthogonalize(wps));
    if (crosses(nw, exclude)) {
      const exitDir = unitAxis(nw[0]!, nw[1]!);
      const entryDir = unitAxis(nw[nw.length - 2]!, nw[nw.length - 1]!);
      nw = routeAroundBoxes(nw[0]!, exitDir, nw[nw.length - 1]!, entryDir, figs.map((f) => f.b));
    }
    edge.waypoint = nw.map((p) =>
      di.moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }),
    ) as unknown as ModdleElement[];
  }
}

/** Ruta ortogonal (Z) simple entre dos cajas, en sus lados enfrentados. */
function orthoRoute(srcB: Bounds, tgtB: Bounds): Point[] {
  const sc = { x: srcB.x + srcB.width / 2, y: srcB.y + srcB.height / 2 };
  const tc = { x: tgtB.x + tgtB.width / 2, y: tgtB.y + tgtB.height / 2 };
  const dx = tc.x - sc.x;
  const dy = tc.y - sc.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? srcB.x + srcB.width : srcB.x;
    const tx = dx >= 0 ? tgtB.x : tgtB.x + tgtB.width;
    const midX = (sx + tx) / 2;
    return [
      { x: sx, y: sc.y },
      { x: midX, y: sc.y },
      { x: midX, y: tc.y },
      { x: tx, y: tc.y },
    ];
  }
  const sy = dy >= 0 ? srcB.y + srcB.height : srcB.y;
  const ty = dy >= 0 ? tgtB.y : tgtB.y + tgtB.height;
  const midY = (sy + ty) / 2;
  return [
    { x: sc.x, y: sy },
    { x: sc.x, y: midY },
    { x: tc.x, y: midY },
    { x: tc.x, y: ty },
  ];
}

/**
 * Como stripRefs, pero PRESERVA el layout: no re-layoutea. Quita las bolitas y
 * restaura la linea con una ruta ortogonal simple entre las cajas en sus
 * posiciones ACTUALES, dejando intactas las posiciones de todos los nodos.
 * Sirve para recalcular refs sobre un diagrama editado a mano sin perder los
 * cambios (cajas movidas, textos, etc.).
 */
export async function stripRefsKeepLayout(
  xml: string,
  onlyEids?: Set<string>,
): Promise<string> {
  const di = await parseDi(xml);
  const proc = getProcess(di);
  const fe = (proc?.flowElements as ModdleElement[]) ?? [];
  const byId = new Map<string, ModdleElement>();
  for (const el of fe) byId.set(el.id as string, el);
  const boundsByRef = new Map<string, Bounds>();
  for (const s of di.shapes) boundsByRef.set(refId(s), boundsOf(s));

  const planeEls = di.plane.planeElement as ModdleElement[];
  // DI edges por su id (para leer el glue de los segmentos del ref).
  const diEdgeById = new Map<string, ModdleElement>();
  for (const e of di.edges) diEdgeById.set(e.id as string, e);

  // Cajas obstaculo (figuras chicas, no lanes/pool) para esquivar al rutear.
  const obstacleList: Array<{ id: string; b: Bounds }> = di.shapes
    .filter((s) => {
      const b = boundsOf(s);
      return b.width < 400 && b.height < 250;
    })
    .map((s) => ({ id: refId(s), b: boundsOf(s) }));

  // Revertir todos los refs, o solo los de onlyEids (para el diff incremental).
  const eids = new Set<string>();
  for (const el of fe) {
    const m = /^RefOut_(.+)$/.exec((el.id as string) ?? '');
    if (m && (!onlyEids || onlyEids.has(m[1]!))) eids.add(m[1]!);
  }

  for (const eid of eids) {
    const throwEv = byId.get(`RefOut_${eid}`);
    const catchEv = byId.get(`RefIn_${eid}`);
    const fTo = byId.get(`Flow_toRef_${eid}`);
    const fFrom = byId.get(`Flow_fromRef_${eid}`);
    if (!throwEv || !catchEv || !fTo || !fFrom) continue;

    const source = fTo.sourceRef as ModdleElement;
    const target = fFrom.targetRef as ModdleElement;

    // Trayectoria ACTUAL de los segmentos del ref (para trazar la linea igual,
    // conservando por donde sale/entra, aunque el usuario haya movido bolitas).
    const outSeg = waypointsOf(diEdgeById.get(`Edge_toRef_${eid}`) ?? ({} as ModdleElement));
    const inSeg = waypointsOf(diEdgeById.get(`Edge_fromRef_${eid}`) ?? ({} as ModdleElement));

    // Semantico: descablear y quitar los elementos ref.
    detachFlow(source, fTo, 'outgoing');
    detachFlow(target, fFrom, 'incoming');
    for (const el of [throwEv, catchEv, fTo, fFrom]) removeFlowElement(fe, el);

    // DI: quitar shapes de las bolitas y los segmentos.
    const kill = new Set([
      `Ref_Out_${eid}`, `Ref_In_${eid}`, `Edge_toRef_${eid}`, `Edge_fromRef_${eid}`,
    ]);
    for (let i = planeEls.length - 1; i >= 0; i--) {
      if (kill.has(planeEls[i]!.id as string)) planeEls.splice(i, 1);
    }

    // Restaurar la linea (semantico) + su DI con ruta ortogonal en las
    // posiciones actuales de las cajas.
    const line = di.moddle.create('bpmn:SequenceFlow', {
      id: eid,
      name: (fTo.name as string) || undefined,
      sourceRef: source,
      targetRef: target,
    });
    fe.push(line);
    attachFlow(source, line, 'outgoing');
    attachFlow(target, line, 'incoming');

    const srcB = boundsByRef.get(source.id as string);
    const tgtB = boundsByRef.get(target.id as string);
    if (srcB && tgtB) {
      // Rutear conservando los lados de salida/entrada del ref y esquivando las
      // figuras. Ortogonal, sin picos. Se incluyen source/target como obstaculos
      // (la linea egresa por los escapes, no corta su interior); solo se excluyen
      // las bolitas del ref que estamos revirtiendo.
      const obstacles = obstacleList
        .filter((o) => o.id !== `RefOut_${eid}` && o.id !== `RefIn_${eid}`)
        .map((o) => o.b);
      let wps: Point[];
      if (outSeg.length >= 2 && inSeg.length >= 2) {
        const exitDir = unitAxis(outSeg[0]!, outSeg[1]!);
        const entryDir = unitAxis(inSeg[inSeg.length - 2]!, inSeg[inSeg.length - 1]!);
        wps = routeAroundBoxes(outSeg[0]!, exitDir, inSeg[inSeg.length - 1]!, entryDir, obstacles);
      } else {
        wps = simplifyOrtho(orthogonalize(orthoRoute(srcB, tgtB)));
      }
      planeEls.push(
        di.moddle.create('bpmndi:BPMNEdge', {
          id: `BPMNEdge_${eid}`,
          bpmnElement: line,
          waypoint: wps.map((p) =>
            di.moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }),
          ),
        }),
      );
    }
  }

  return serializeDi(di);
}
