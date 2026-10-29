/**
 * Validacion del grafo de entrada (Contrato A) antes de generar BPMN.
 * Ver seccion 9 del handoff: los datos vienen de un servicio externo y hay que
 * fallar ruidosamente ANTES de tocar el layout, senalando el problema concreto.
 *
 * Esta capa cubre invariantes de grafo que el JSON Schema no puede expresar
 * (referencias cruzadas, alcanzabilidad, unicidad semantica).
 */

import type { ContractA } from '../contracts/contract-a';

export class GraphValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Contrato A invalido:\n  - ${issues.join('\n  - ')}`);
    this.name = 'GraphValidationError';
    this.issues = issues;
  }
}

export function validateContract(c: ContractA): void {
  const issues: string[] = [];

  // --- Unicidad de ids ---
  const laneIds = new Set<string>();
  for (const lane of c.lanes) {
    if (laneIds.has(lane.id)) issues.push(`Lane id duplicado: "${lane.id}"`);
    laneIds.add(lane.id);
  }

  const nodeIds = new Set<string>();
  for (const node of c.nodes) {
    if (nodeIds.has(node.id)) issues.push(`Node id duplicado: "${node.id}"`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of c.edges) {
    if (edgeIds.has(edge.id)) issues.push(`Edge id duplicado: "${edge.id}"`);
    edgeIds.add(edge.id);
  }

  // --- Lanes: order contiguo desde 0 ---
  const orders = [...c.lanes].map((l) => l.order).sort((a, b) => a - b);
  orders.forEach((order, i) => {
    if (order !== i) {
      issues.push(
        `El "order" de las lanes debe ser contiguo desde 0. Falta el order ${i} (se encontro ${order}).`,
      );
    }
  });

  // --- Nodos: la lane referenciada existe ---
  for (const node of c.nodes) {
    if (!laneIds.has(node.lane)) {
      issues.push(`El nodo "${node.id}" referencia una lane inexistente: "${node.lane}".`);
    }
  }

  // --- Aristas: from/to existen ---
  for (const edge of c.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push(`La arista "${edge.id}" tiene un "from" inexistente: "${edge.from}".`);
    }
    if (!nodeIds.has(edge.to)) {
      issues.push(`La arista "${edge.id}" tiene un "to" inexistente: "${edge.to}".`);
    }
  }

  // --- Eventos de inicio / fin ---
  const starts = c.nodes.filter((n) => n.type === 'startEvent');
  const ends = c.nodes.filter((n) => n.type === 'endEvent');
  if (starts.length === 0) issues.push('El proceso no tiene ningun startEvent.');
  if (ends.length === 0) issues.push('El proceso no tiene ningun endEvent.');

  // --- Grados por tipo ---
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of c.edges) {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  for (const node of c.nodes) {
    const inn = incoming.get(node.id) ?? 0;
    const out = outgoing.get(node.id) ?? 0;

    if (node.type === 'startEvent' && inn > 0) {
      issues.push(`El startEvent "${node.id}" no puede tener aristas de entrada.`);
    }
    if (node.type === 'endEvent' && out > 0) {
      issues.push(`El endEvent "${node.id}" no puede tener aristas de salida.`);
    }
    // Nodos huerfanos: sin entrada ni salida (salvo el caso degenerado de un
    // unico nodo, que igual no tiene sentido en un proceso).
    if (inn === 0 && out === 0) {
      issues.push(`El nodo "${node.id}" es huerfano: no tiene entradas ni salidas.`);
    }
    if (node.type !== 'startEvent' && inn === 0) {
      issues.push(`El nodo "${node.id}" no es alcanzable: no tiene aristas de entrada.`);
    }
    if (node.type !== 'endEvent' && out === 0) {
      issues.push(`El nodo "${node.id}" no llega a ningun lado: no tiene aristas de salida.`);
    }
  }

  if (issues.length > 0) {
    throw new GraphValidationError(issues);
  }
}
