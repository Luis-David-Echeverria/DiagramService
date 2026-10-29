/**
 * Contrato A -> BPMN 2.0 semantico (sin DI).
 *
 * Construimos una Collaboration con un unico Participant que referencia un
 * Process con un LaneSet. bpmn-auto-layout@2.x-alpha necesita esta forma
 * (Collaboration + Participant + Process + Lanes) para poder disponer las
 * bandas horizontales; la version estable 1.3.0 no lo soporta (ver handoff 5).
 *
 * NO emitimos DI aca: el layouter resetea definitions.diagrams y genera la
 * geometria. La salida de esta etapa (tras layoutProcess) es BPMN con DI
 * completo = Contrato B.
 */

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';
import type { ContractA, NodeType } from '../contracts/contract-a';

/** Mapea el vocabulario cerrado del Contrato A a tipos moddle de BPMN. */
const TYPE_MAP: Record<NodeType, string> = {
  startEvent: 'bpmn:StartEvent',
  endEvent: 'bpmn:EndEvent',
  userTask: 'bpmn:UserTask',
  serviceTask: 'bpmn:ServiceTask',
  task: 'bpmn:Task',
  exclusiveGateway: 'bpmn:ExclusiveGateway',
  parallelGateway: 'bpmn:ParallelGateway',
};

export interface BuildOptions {
  /**
   * Ids de aristas (Contrato A) que deben emitirse como refs off-page (par de
   * Link Events nativos, que bpmn-auto-layout posiciona solo). La decision de
   * CUALES se toma afuera (ref-cutter, midiendo el layout real). Vacio o ausente
   * = sin refs.
   */
  cutEdgeIds?: Set<string>;
}

export interface BuildResult {
  xml: string;
  /** Refs off-page creadas (aristas convertidas en Link Events). */
  refs: Array<{ code: string; from: string; to: string }>;
}

/** Codigo del ref: A, B, ... Z, AA, AB, ... */
function linkCode(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Devuelve el XML BPMN semantico (sin DI) listo para pasar por layoutProcess.
 */
export async function buildSemanticBpmn(
  contract: ContractA,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const moddle = new BpmnModdle();
  const cutEdgeIds = options.cutEdgeIds ?? new Set<string>();
  const refs: BuildResult['refs'] = [];

  // Nota → bpmn:documentation (nativo; lo conserva el layout y cualquier editor).
  const docOf = (text?: string) =>
    text ? [moddle.create('bpmn:Documentation', { text })] : undefined;

  // --- Flow nodes ---
  const flowNodeById = new Map<string, ModdleElement>();
  for (const node of contract.nodes) {
    const el = moddle.create(TYPE_MAP[node.type], {
      id: node.id,
      name: node.name || undefined,
      documentation: docOf(node.description),
    });
    flowNodeById.set(node.id, el);
  }

  // Lane de cada nodo (para asignar los Link Events a la lane correcta).
  const laneOfNode = new Map<string, string>();
  for (const n of contract.nodes) laneOfNode.set(n.id, n.lane);

  // --- Sequence flows + Link Events off-page (refs) ---
  // Una arista en cutEdgeIds se parte en:
  //   origen -> [Throw Link "X"]   y   [Catch Link "X"] -> destino
  // bpmn-auto-layout reconoce el par (mismo name) y lo posiciona nativamente.
  const sequenceFlows: ModdleElement[] = [];
  const linkNodes: ModdleElement[] = [];
  // Miembros extra por lane (los Link Events que caen en cada carril).
  const extraLaneMembers = new Map<string, ModdleElement[]>();
  let linkCounter = 0;

  const addLaneMember = (laneId: string, el: ModdleElement) => {
    if (!extraLaneMembers.has(laneId)) extraLaneMembers.set(laneId, []);
    extraLaneMembers.get(laneId)!.push(el);
  };

  for (const edge of contract.edges) {
    const source = flowNodeById.get(edge.from)!;
    const target = flowNodeById.get(edge.to)!;
    const isRef = cutEdgeIds.has(edge.id);

    if (!isRef) {
      const flow = moddle.create('bpmn:SequenceFlow', {
        id: edge.id,
        name: edge.label || undefined,
        sourceRef: source,
        targetRef: target,
      });
      sequenceFlows.push(flow);
      ((source.outgoing ??= []) as ModdleElement[]).push(flow);
      ((target.incoming ??= []) as ModdleElement[]).push(flow);
      continue;
    }

    // --- ref off-page: par de Link Events ---
    const code = linkCode(linkCounter++);
    const linkName = `L${code}`;
    refs.push({ code, from: edge.from, to: edge.to });
    const throwEv = moddle.create('bpmn:IntermediateThrowEvent', {
      id: `RefOut_${edge.id}`,
      name: `(${code})`,
      eventDefinitions: [
        moddle.create('bpmn:LinkEventDefinition', { id: `LinkOut_${edge.id}`, name: linkName }),
      ],
    });
    const catchEv = moddle.create('bpmn:IntermediateCatchEvent', {
      id: `RefIn_${edge.id}`,
      name: `(${code})`,
      eventDefinitions: [
        moddle.create('bpmn:LinkEventDefinition', { id: `LinkIn_${edge.id}`, name: linkName }),
      ],
    });
    linkNodes.push(throwEv, catchEv);

    // origen -> throw
    const f1 = moddle.create('bpmn:SequenceFlow', {
      id: `${edge.id}_toRef`,
      name: edge.label || undefined,
      sourceRef: source,
      targetRef: throwEv,
    });
    ((source.outgoing ??= []) as ModdleElement[]).push(f1);
    ((throwEv.incoming ??= []) as ModdleElement[]).push(f1);
    // catch -> destino
    const f2 = moddle.create('bpmn:SequenceFlow', {
      id: `${edge.id}_fromRef`,
      sourceRef: catchEv,
      targetRef: target,
    });
    ((catchEv.outgoing ??= []) as ModdleElement[]).push(f2);
    ((target.incoming ??= []) as ModdleElement[]).push(f2);
    sequenceFlows.push(f1, f2);

    // Los Link Events viven en la lane de su nodo asociado.
    addLaneMember(laneOfNode.get(edge.from) ?? contract.lanes[0]!.id, throwEv);
    addLaneMember(laneOfNode.get(edge.to) ?? contract.lanes[0]!.id, catchEv);
  }

  // --- Data stores (tambores) + asociaciones (líneas punteadas) ---
  // Cilindros nativos compartidos; cada actividad los LEE (DataInputAssociation,
  // línea entrante) o los ESCRIBE (DataOutputAssociation, línea saliente).
  const dataStoreById = new Map<string, ModdleElement>();
  for (const ds of contract.dataStores ?? []) {
    dataStoreById.set(ds.id, moddle.create('bpmn:DataStoreReference', { id: ds.id, name: ds.name || undefined }));
  }
  for (const node of contract.nodes) {
    const activity = flowNodeById.get(node.id)!;
    for (const dsId of node.reads ?? []) {
      const store = dataStoreById.get(dsId);
      if (!store) continue;
      const assoc = moddle.create('bpmn:DataInputAssociation', { id: `DIA_${node.id}_${dsId}`, sourceRef: [store] });
      ((activity.dataInputAssociations ??= []) as ModdleElement[]).push(assoc);
    }
    for (const dsId of node.writes ?? []) {
      const store = dataStoreById.get(dsId);
      if (!store) continue;
      const assoc = moddle.create('bpmn:DataOutputAssociation', { id: `DOA_${node.id}_${dsId}`, targetRef: store });
      ((activity.dataOutputAssociations ??= []) as ModdleElement[]).push(assoc);
    }
  }

  const flowElements = [
    ...flowNodeById.values(),
    ...dataStoreById.values(),
    ...linkNodes,
    ...sequenceFlows,
  ];

  // --- LaneSet: una lane por banda, ordenadas de arriba hacia abajo ---
  const orderedLanes = [...contract.lanes].sort((a, b) => a.order - b.order);
  const lanes = orderedLanes.map((lane) => {
    const members = [
      ...contract.nodes.filter((n) => n.lane === lane.id).map((n) => flowNodeById.get(n.id)!),
      ...(extraLaneMembers.get(lane.id) ?? []),
    ];
    return moddle.create('bpmn:Lane', {
      id: lane.id,
      name: lane.name,
      flowNodeRef: members,
    });
  });
  const laneSet = moddle.create('bpmn:LaneSet', {
    id: `${contract.process.id}_LaneSet`,
    lanes,
  });

  // --- Process ---
  const process = moddle.create('bpmn:Process', {
    id: contract.process.id,
    name: contract.process.name,
    isExecutable: false,
    documentation: docOf(contract.process.description),
    laneSets: [laneSet],
    flowElements,
  });

  // --- Collaboration + Participant (pool) ---
  const participant = moddle.create('bpmn:Participant', {
    id: `${contract.process.id}_Participant`,
    name: contract.process.name,
    processRef: process,
  });
  const collaboration = moddle.create('bpmn:Collaboration', {
    id: `${contract.process.id}_Collaboration`,
    participants: [participant],
  });

  // --- Definitions ---
  const definitions = moddle.create('bpmn:Definitions', {
    id: `${contract.process.id}_Definitions`,
    targetNamespace: 'http://fluence.internal/bpmn',
    rootElements: [collaboration, process],
  });

  const { xml } = await moddle.toXML(definitions, { format: true });
  return { xml, refs };
}
