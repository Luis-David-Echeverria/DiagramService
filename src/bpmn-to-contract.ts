/**
 * BPMN → Contrato A (proyección lógica). Inverso de build-bpmn.
 *
 * Produce EXACTAMENTE el mismo formato que la entrada (Contrato A v2), sin
 * geometría, para garantizar transparencia: JSON → BPMN → JSON devuelve el
 * mismo proceso lógico. Es la vista que consume la IA (el "MCP del diagrama").
 *
 * Dos reconstrucciones clave para la transparencia:
 *  - Las refs off-page (par RefOut_/RefIn_ + flujos _toRef/_fromRef) son
 *    artefactos de LAYOUT: se colapsan de vuelta a su arista original.
 *  - La membresía de carril sale del flowNodeRef; el `order` de la posición
 *    vertical del DI (o del índice del LaneSet si no hay DI).
 */
import { BpmnModdle } from "bpmn-moddle";
import { fluModdleDescriptor } from "./flu-ext";
import type { ContractA, Edge, NodeType, ProcessNode, RcoItem } from "./pipeline/contracts/contract-a";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Inverso del TYPE_MAP de build-bpmn.
const TYPE_BACK: Record<string, NodeType> = {
    "bpmn:StartEvent": "startEvent",
    "bpmn:EndEvent": "endEvent",
    "bpmn:UserTask": "userTask",
    "bpmn:ServiceTask": "serviceTask",
    "bpmn:Task": "task",
    "bpmn:ExclusiveGateway": "exclusiveGateway",
    "bpmn:ParallelGateway": "parallelGateway",
};

/** id de una referencia moddle (resuelta a objeto) o de un string. */
const refId = (x: any): string => (typeof x === "string" ? x : x?.id ?? "");

function docText(el: any): string | undefined {
    const d = (el.documentation as any[])?.[0];
    const t = d?.text ?? d?.get?.("text");
    return t && String(t).trim() ? String(t) : undefined;
}

/** Lee riesgos/controles/oportunidades de flu:extensionElements de un elemento. */
function readFlu(el: any): Pick<ProcessNode, "risks" | "controls" | "opportunities"> {
    const values = el.extensionElements?.get?.("values") ?? el.extensionElements?.values;
    const metas = ((values as any[]) ?? []).filter((v) => v.$type === "flu:Meta");
    const out: { risks?: RcoItem[]; controls?: RcoItem[]; opportunities?: RcoItem[] } = {};
    for (const m of metas) {
        for (const it of ((m.items as any[]) ?? [])) {
            const key = it.kind === "control" ? "controls" : it.kind === "opportunity" ? "opportunities" : "risks";
            (out[key] ??= []).push({ code: it.code || undefined, text: it.text ?? "" });
        }
    }
    return out;
}

/** y del DI por bpmnElement (para ordenar carriles arriba→abajo). */
function diYPositions(defs: any): Map<string, number> {
    const map = new Map<string, number>();
    for (const dia of ((defs.diagrams as any[]) ?? [])) {
        for (const pe of ((dia.plane?.planeElement as any[]) ?? [])) {
            if (pe.$type === "bpmndi:BPMNShape" && pe.bpmnElement && pe.bounds) {
                map.set(refId(pe.bpmnElement), pe.bounds.y);
            }
        }
    }
    return map;
}

export async function bpmnToContract(xml: string): Promise<ContractA> {
    const moddle = new BpmnModdle({ flu: fluModdleDescriptor });
    const { rootElement: defs } = await moddle.fromXML(xml);

    const process = ((defs.rootElements as any[]) ?? []).find((r) => r.$type === "bpmn:Process");
    if (!process) throw new Error("El BPMN no contiene un Process.");

    const flowElements: any[] = (process.flowElements as any[]) ?? [];
    const byId = new Map<string, any>();
    for (const fe of flowElements) byId.set(fe.id, fe);
    const flows = flowElements.filter((f) => f.$type === "bpmn:SequenceFlow");

    // --- Data stores (tambores) ---
    const dataStores = flowElements
        .filter((f) => f.$type === "bpmn:DataStoreReference")
        .map((f) => ({ id: f.id as string, name: (f.name as string) ?? "" }));

    // --- Colapsar refs off-page a su arista original ---
    const skipNodeIds = new Set<string>(); // RefOut_/RefIn_
    const skipFlowIds = new Set<string>(); // _toRef/_fromRef
    const rebuiltEdges: Edge[] = [];
    for (const fe of flowElements) {
        const m = /^RefOut_(.+)$/.exec(fe.id);
        if (!m || fe.$type !== "bpmn:IntermediateThrowEvent") continue;
        const edgeId = m[1];
        const catchEv = byId.get(`RefIn_${edgeId}`);
        const toRef = flows.find((f) => refId(f.targetRef) === fe.id); // origen → throw
        const fromRef = catchEv && flows.find((f) => refId(f.sourceRef) === catchEv.id); // catch → destino
        if (!toRef || !fromRef) continue;
        skipNodeIds.add(fe.id);
        if (catchEv) skipNodeIds.add(catchEv.id);
        skipFlowIds.add(toRef.id);
        skipFlowIds.add(fromRef.id);
        const edge: Edge = { id: edgeId, from: refId(toRef.sourceRef), to: refId(fromRef.targetRef) };
        if (toRef.name) edge.label = toRef.name;
        rebuiltEdges.push(edge);
    }

    // --- Lanes + membresía nodeId → laneId ---
    const laneEls: any[] = ((process.laneSets as any[])?.[0]?.lanes as any[]) ?? [];
    const laneOfNode = new Map<string, string>();
    for (const lane of laneEls) {
        for (const member of ((lane.flowNodeRef as any[]) ?? [])) {
            const id = refId(member);
            if (id) laneOfNode.set(id, lane.id);
        }
    }
    const y = diYPositions(defs);
    const lanesSorted = [...laneEls].sort((a, b) => (y.get(a.id) ?? 0) - (y.get(b.id) ?? 0));
    const lanes = lanesSorted.map((lane, i) => ({ id: lane.id, name: lane.name ?? "", order: i }));

    // --- Nodos (vocabulario cerrado; se ignoran refs y no-nodos como flujos) ---
    const nodes: ProcessNode[] = [];
    for (const fe of flowElements) {
        if (skipNodeIds.has(fe.id)) continue;
        const type = TYPE_BACK[fe.$type];
        if (!type) continue;
        const node: ProcessNode = {
            id: fe.id,
            type,
            name: fe.name ?? "",
            lane: laneOfNode.get(fe.id) ?? lanes[0]?.id ?? "",
        };
        const desc = docText(fe);
        if (desc) node.description = desc;
        // Asociaciones de datos (líneas punteadas) → reads/writes.
        const reads = ((fe.dataInputAssociations as any[]) ?? [])
            .flatMap((a) => ((a.sourceRef as any[]) ?? []).map(refId)).filter(Boolean);
        const writes = ((fe.dataOutputAssociations as any[]) ?? [])
            .map((a) => refId(a.targetRef)).filter(Boolean);
        if (reads.length) node.reads = reads;
        if (writes.length) node.writes = writes;
        const rco = readFlu(fe);
        if (rco.risks?.length) node.risks = rco.risks;
        if (rco.controls?.length) node.controls = rco.controls;
        if (rco.opportunities?.length) node.opportunities = rco.opportunities;
        nodes.push(node);
    }

    // --- Aristas normales + las reconstruidas desde refs ---
    const edges: Edge[] = [];
    for (const f of flows) {
        if (skipFlowIds.has(f.id)) continue;
        const from = refId(f.sourceRef);
        const to = refId(f.targetRef);
        if (!from || !to || skipNodeIds.has(from) || skipNodeIds.has(to)) continue;
        const edge: Edge = { id: f.id, from, to };
        if (f.name) edge.label = f.name;
        edges.push(edge);
    }
    edges.push(...rebuiltEdges);

    const contract: ContractA = {
        schemaVersion: "contrato-a",
        version: "2.0.0",
        process: { id: process.id, name: process.name ?? "" },
        lanes,
        nodes,
        edges,
    };
    if (dataStores.length) contract.dataStores = dataStores;
    const pdesc = docText(process);
    if (pdesc) contract.process.description = pdesc;
    return contract;
}
