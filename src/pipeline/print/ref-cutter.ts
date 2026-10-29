/**
 * ref-cutter: decide QUE aristas convertir en refs off-page, midiendo el layout
 * REAL. Criterio: DISTANCIA entre las cajas de origen y destino (centro a
 * centro). Toda arista cuya distancia supere el umbral en px se vuelve ref.
 *
 * Por que distancia entre cajas y no largo de la polilinea: la distancia entre
 * cajas es ESTABLE (no depende del ruteo). Asi la decision es la misma en la
 * generacion inicial y al recalcular refs sobre un diagrama editado (idempotente
 * si no se movieron las cajas). El largo de polilinea variaba segun la ruta y
 * hacia que aristas cerca del umbral cambiaran de estado solas.
 *
 *   0 (o menos) = no corta nada.
 *   X px        = corta toda arista cuyas cajas esten a mas de X px.
 */

import { parseDi, boundsOf, refId } from '../contracts/di';
import type { ModdleElement } from 'bpmn-moddle';

export interface CutResult {
  edgeIds: Set<string>;
  thresholdPx: number;
}

export async function decideCuts(laidOutXml: string, maxLenPx: number): Promise<CutResult> {
  const threshold = maxLenPx;
  if (!(threshold > 0)) return { edgeIds: new Set(), thresholdPx: Infinity };

  const di = await parseDi(laidOutXml);

  // Centro de cada nodo por su id.
  const center = new Map<string, { x: number; y: number }>();
  for (const s of di.shapes) {
    const b = boundsOf(s);
    center.set(refId(s), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }

  const edgeIds = new Set<string>();
  for (const edge of di.edges) {
    const id = refId(edge);
    if (!id) continue;
    const flow = edge.bpmnElement as ModdleElement | undefined;
    const from = ((flow?.sourceRef as ModdleElement)?.id as string) ?? '';
    const to = ((flow?.targetRef as ModdleElement)?.id as string) ?? '';
    const a = center.get(from);
    const b = center.get(to);
    if (!a || !b) continue;
    if (Math.hypot(b.x - a.x, b.y - a.y) > threshold) edgeIds.add(id);
  }
  return { edgeIds, thresholdPx: threshold };
}
