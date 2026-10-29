import type { ContractA } from "./pipeline/contracts/contract-a";
import { runPipeline, type PipelineDeps } from "./pipeline/pipeline";
import { defaultLayouter } from "./pipeline/layout/auto-layouter";
import { decideCuts } from "./pipeline/print/ref-cutter";
import { DiPrinter } from "./pipeline/print/printer";
import { stripRefs, stripRefsKeepLayout } from "./pipeline/print/refs";
import { extractFlu, fluFromContract, injectFlu } from "./flu-ext";

export type { ContractA, ProcessNode, Edge, Lane, DataStore, RcoItem } from "./pipeline/contracts/contract-a";
export type { PipelineDeps, PipelineResult } from "./pipeline/pipeline";
export { validateContract, GraphValidationError } from "./pipeline/ingest/validate";
export { bpmnToContract } from "./bpmn-to-contract";
export { fluModdleDescriptor } from "./flu-ext";

/** Contrato A lógico → BPMN 2.0 con DI, refs y metadatos flu:. */
export async function generateDiagram(contract: ContractA, options: PipelineDeps = {}) {
    const result = await runPipeline(contract, options);
    return { ...result, xml: await injectFlu(result.xml, fluFromContract(contract)) };
}

/** Reordena el XML entero. Úsalo solo cuando el usuario pida autoorganizar: cambia posiciones manuales. */
export async function relayoutDiagram(xml: string, refMaxLenPx = 0, forceRef: string[] = [], forceLine: string[] = []) {
    const flu = await extractFlu(xml);
    const clean = await stripRefs(xml);
    const { xml: laidOut, warnings } = await defaultLayouter.layout(clean);
    const auto = refMaxLenPx > 0 ? (await decideCuts(laidOut, refMaxLenPx)).edgeIds : new Set<string>();
    const cut = new Set(auto);
    for (const id of forceRef) cut.add(id);
    for (const id of forceLine) cut.delete(id);
    const result = await new DiPrinter().prepare(laidOut, cut);
    return { ...result, xml: await injectFlu(result.xml, flu), warnings };
}

/** Cambia refs off-page sin recalcular la geometría existente del editor. */
export async function updateReferences(xml: string, refMaxLenPx = 0, forceRef: string[] = [], forceLine: string[] = []) {
    const flu = await extractFlu(xml);
    const currentRefs = new Set([...xml.matchAll(/id="RefOut_([^"]+)"/g)].map((match) => match[1]));
    const allLines = await stripRefsKeepLayout(xml);
    const auto = refMaxLenPx > 0 ? (await decideCuts(allLines, refMaxLenPx)).edgeIds : new Set<string>();
    const cut = new Set(auto);
    for (const id of forceRef) cut.add(id);
    for (const id of forceLine) cut.delete(id);
    const toRemove = new Set([...currentRefs].filter((id) => !cut.has(id)));
    const toAdd = new Set([...cut].filter((id) => !currentRefs.has(id)));
    const base = toRemove.size ? await stripRefsKeepLayout(xml, toRemove) : xml;
    const result = await new DiPrinter({ pagination: { enabled: false, pageSize: "carta", marginPx: 0 } }).prepare(base, toAdd);
    return { ...result, xml: await injectFlu(result.xml, flu) };
}
