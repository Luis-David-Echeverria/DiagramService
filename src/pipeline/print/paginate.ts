/**
 * Reparto del diagrama en paginas de tamano fijo, SIN partir nodos.
 *
 * Enfoque (decidido con el usuario): el diagrama se mantiene a tamano legible
 * (no se escala); si no cabe en una hoja, se reparte en N hojas. Los cortes
 * caen en los HUECOS entre nodos, nunca sobre una caja. Un nodo puede ser mas
 * ancho/alto que la pagina util en casos extremos: en ese caso su franja mide
 * lo que mida el nodo (se acepta que una hoja tenga un poco de desborde antes
 * que cortar la caja).
 *
 * Estrategia de corte actual: franjas VERTICALES (columnas). El proceso avanza
 * a lo ancho por los lanes horizontales, asi que cortar en columnas = "esta
 * hoja es este tramo del proceso". El corte por filas se agrega solo si el
 * contenido excede tambien el alto util.
 *
 * No modifica el DI: lo lee y produce un PaginationResult inspeccionable.
 */

import type { DiModel, Bounds } from '../contracts/di';
import { boundsOf, contentExtent, refId, isLaneId } from '../contracts/di';
import { PAGE_SIZES, type PaginationConfig } from './render-config';

export interface PageCell {
  col: number;
  row: number;
  label: string;
  /** Rectangulo que cubre esta pagina en coordenadas del lienzo. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaginationResult {
  enabled: boolean;
  pageSize: { key: string; width: number; height: number };
  cols: number;
  rows: number;
  /** Posiciones X de los cortes verticales (en coords del lienzo). */
  colBreaks: number[];
  /** Posiciones Y de los cortes horizontales. */
  rowBreaks: number[];
  pages: PageCell[];
  /** id de forma -> label de pagina donde cae su centro. */
  shapePage: Record<string, string>;
  /** true si algun nodo, por si solo, no cabe en la pagina util. */
  hasOversizedNode: boolean;
}

const EMPTY: PaginationResult = {
  enabled: false,
  pageSize: { key: '', width: 0, height: 0 },
  cols: 0,
  rows: 0,
  colBreaks: [],
  rowBreaks: [],
  pages: [],
  shapePage: {},
  hasOversizedNode: false,
};

/**
 * Dado un eje (los intervalos [start,end] de las cajas proyectadas sobre X o Y)
 * y el ancho util de la pagina, devuelve las posiciones de corte que:
 *   - no parten ninguna caja (caen en huecos entre cajas)
 *   - meten tantas cajas como sea posible por pagina sin exceder `usable`
 * Devuelve los limites de cada franja como pares [from, to].
 */
function cutIntoStrips(
  intervals: { lo: number; hi: number }[],
  originStart: number,
  contentEnd: number,
  usable: number,
): { from: number; to: number }[] {
  if (intervals.length === 0) return [{ from: originStart, to: contentEnd }];

  // Ordenar por inicio.
  const items = [...intervals].sort((a, b) => a.lo - b.lo);
  const strips: { from: number; to: number }[] = [];

  let stripStart = originStart;
  let i = 0;
  while (i < items.length) {
    const pageLimit = stripStart + usable;
    // Meter cajas mientras entren dentro del limite de la pagina.
    let j = i;
    let stripMaxHi = items[i]!.hi;
    while (j < items.length && items[j]!.hi <= pageLimit) {
      stripMaxHi = Math.max(stripMaxHi, items[j]!.hi);
      j++;
    }
    if (j === i) {
      // La caja i sola ya excede la pagina util: le damos su propia franja
      // (se acepta desborde antes que cortarla).
      stripMaxHi = items[i]!.hi;
      j = i + 1;
    }
    // El corte cae DESPUES de la ultima caja que entro y ANTES de la siguiente,
    // en el punto medio del hueco (si hay siguiente).
    const next = items[j];
    const cutAt = next ? (stripMaxHi + next.lo) / 2 : contentEnd;
    strips.push({ from: stripStart, to: cutAt });
    stripStart = cutAt;
    i = j;
  }
  // Asegurar que la ultima franja llegue al final del contenido.
  if (strips.length) strips[strips.length - 1]!.to = Math.max(strips[strips.length - 1]!.to, contentEnd);
  return strips;
}

export function paginate(di: DiModel, cfg: PaginationConfig): PaginationResult {
  if (!cfg.enabled) return EMPTY;

  const size = PAGE_SIZES[cfg.pageSize];
  const usableW = Math.max(1, size.width - cfg.marginPx * 2);
  const usableH = Math.max(1, size.height - cfg.marginPx * 2);

  // Solo contenido real (nodos + refs), no la pool ni las lanes.
  const contentShapes = di.shapes.filter((s) => !isLaneId(refId(s)));
  const shapes = contentShapes.length ? contentShapes : di.shapes;
  const ext = contentExtent(shapes);

  const boxes: Bounds[] = shapes.map(boundsOf);
  const hasOversizedNode = boxes.some((b) => b.width > usableW || b.height > usableH);

  // Cortes verticales (columnas): proyectar cada caja sobre X.
  const xIntervals = boxes.map((b) => ({ lo: b.x, hi: b.x + b.width }));
  const colStrips = cutIntoStrips(xIntervals, ext.x, ext.x + ext.width, usableW);

  // Cortes horizontales (filas): proyectar sobre Y. En la mayoria de procesos
  // con lanes esto da 1 sola fila (todo cabe en alto), pero lo soportamos.
  const yIntervals = boxes.map((b) => ({ lo: b.y, hi: b.y + b.height }));
  const rowStrips = cutIntoStrips(yIntervals, ext.y, ext.y + ext.height, usableH);

  const colBreaks = colStrips.slice(0, -1).map((s) => s.to);
  const rowBreaks = rowStrips.slice(0, -1).map((s) => s.to);

  const pages: PageCell[] = [];
  let n = 1;
  for (let row = 0; row < rowStrips.length; row++) {
    for (let col = 0; col < colStrips.length; col++) {
      const cs = colStrips[col]!;
      const rs = rowStrips[row]!;
      pages.push({
        col,
        row,
        label: String(n++),
        x: cs.from,
        y: rs.from,
        width: cs.to - cs.from,
        height: rs.to - rs.from,
      });
    }
  }

  // Asignar cada forma a la pagina que contiene su centro.
  const shapePage: Record<string, string> = {};
  for (const s of shapes) {
    const b = boundsOf(s);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const page = pages.find(
      (p) => cx >= p.x && cx < p.x + p.width && cy >= p.y && cy < p.y + p.height,
    );
    if (page) shapePage[refId(s)] = page.label;
  }

  return {
    enabled: true,
    pageSize: { key: cfg.pageSize, width: size.width, height: size.height },
    cols: colStrips.length,
    rows: rowStrips.length,
    colBreaks,
    rowBreaks,
    pages,
    shapePage,
    hasOversizedNode,
  };
}
