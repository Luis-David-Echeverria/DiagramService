/**
 * Helpers para leer/escribir el DI (Diagram Interchange) de un BPMN ya
 * layouteado. Trabaja sobre el modelo moddle en memoria, no sobre strings.
 *
 * Vocabulario:
 *  - Shape: bpmndi:BPMNShape  (una forma con bounds x/y/w/h)
 *  - Edge:  bpmndi:BPMNEdge   (una arista con waypoints)
 */

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface DiModel {
  moddle: BpmnModdle;
  definitions: ModdleElement;
  plane: ModdleElement;
  shapes: ModdleElement[];
  edges: ModdleElement[];
}

/** Parsea el XML y expone el plano DI y sus elementos ya separados. */
export async function parseDi(xml: string): Promise<DiModel> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const diagrams = (rootElement.diagrams as ModdleElement[]) ?? [];
  const plane = diagrams[0]?.plane as ModdleElement;
  if (!plane) throw new Error('El BPMN no tiene un BPMNPlane (falta DI).');

  const planeElement = (plane.planeElement as ModdleElement[]) ?? [];
  const shapes = planeElement.filter((e) => e.$type === 'bpmndi:BPMNShape');
  const edges = planeElement.filter((e) => e.$type === 'bpmndi:BPMNEdge');

  return { moddle, definitions: rootElement, plane, shapes, edges };
}

/** Serializa el modelo de vuelta a XML formateado. */
export async function serializeDi(di: DiModel): Promise<string> {
  const { xml } = await di.moddle.toXML(di.definitions, { format: true });
  return xml;
}

/** Id del elemento BPMN al que refiere una shape/edge del DI. */
export function refId(diElement: ModdleElement): string {
  const be = diElement.bpmnElement as ModdleElement | undefined;
  return (be?.id as string) ?? '';
}

export function boundsOf(shape: ModdleElement): Bounds {
  return shape.bounds as unknown as Bounds;
}

export function waypointsOf(edge: ModdleElement): Point[] {
  return (edge.waypoint as unknown as Point[]) ?? [];
}

/** True si el id corresponde a una lane (por convencion de nuestro builder). */
export function isLaneId(id: string): boolean {
  return /(^|_)Lane_/.test(id) || id.startsWith('Lane_');
}

/** Bounding box de todas las shapes que NO son la pool ni las lanes. */
export function contentExtent(shapes: ModdleElement[]): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of shapes) {
    const b = boundsOf(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
