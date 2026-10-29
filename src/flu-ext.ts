/**
 * Capa GRC (riesgos / controles / oportunidades) como extension BPMN `flu:`.
 *
 * BPMN no modela riesgos/controles nativamente, así que los guardamos como
 * `bpmn:extensionElements` bajo un namespace propio. Es 100% válido: el archivo
 * abre en cualquier editor BPMN; los que no conocen `flu:` simplemente lo
 * ignoran (pero el modelo sigue siendo estándar). Fluence es el sistema de
 * registro: los dibuja como badges y los usa para el análisis con IA.
 *
 * Como el pipeline (bpmn-auto-layout + printer) re-serializa y puede tirar la
 * data desconocida, el patrón es: EXTRAER antes de cada pasada y RE-INYECTAR al
 * final. La inyección/extracción usan un moddle con este descriptor.
 */
import { BpmnModdle, type ModdleElement } from "bpmn-moddle";
import type { ContractA, RcoItem } from "./pipeline/contracts/contract-a";

export const FLU_PREFIX = "flu";
export const FLU_URI = "http://fluence.mx/schema/bpmn/flu";

/** Descriptor moddle del namespace flu (se registra en el moddle y en el Modeler). */
export const fluModdleDescriptor = {
    name: "Fluence",
    uri: FLU_URI,
    prefix: FLU_PREFIX,
    xml: { tagAlias: "lowerCase" },
    associations: [],
    enumerations: [],
    types: [
        {
            name: "Meta",
            superClass: ["Element"],
            properties: [
                { name: "kind", type: "String", isAttr: true }, // dataStore → se dibuja como cilindro
                { name: "items", type: "Item", isMany: true },
            ],
        },
        {
            name: "Item",
            superClass: ["Element"],
            properties: [
                { name: "kind", type: "String", isAttr: true }, // risk | control | opportunity
                { name: "code", type: "String", isAttr: true },
                { name: "text", type: "String", isBody: true },
            ],
        },
    ],
};

export interface FluData {
    risks: RcoItem[];
    controls: RcoItem[];
    opportunities: RcoItem[];
}

const KIND_KEY = { risk: "risks", control: "controls", opportunity: "opportunities" } as const;

function emptyFlu(): FluData {
    return { risks: [], controls: [], opportunities: [] };
}
function hasAny(d: FluData): boolean {
    return d.risks.length > 0 || d.controls.length > 0 || d.opportunities.length > 0;
}

/** flowElements de todos los Process del documento. */
function flowElementsOf(defs: ModdleElement): ModdleElement[] {
    const out: ModdleElement[] = [];
    for (const root of ((defs.rootElements as ModdleElement[]) ?? [])) {
        if (root.$type === "bpmn:Process") out.push(...((root.flowElements as ModdleElement[]) ?? []));
    }
    return out;
}

function toItems(moddle: BpmnModdle, data: FluData): ModdleElement[] {
    const mk = (kind: string, arr: RcoItem[]) =>
        (arr ?? []).map((it) => moddle.create("flu:Item", { kind, code: it.code || undefined, text: it.text }));
    return [...mk("risk", data.risks), ...mk("control", data.controls), ...mk("opportunity", data.opportunities)];
}

/** Escribe los RCO (por id de nodo) como extensionElements flu en el XML. */
export async function injectFlu(xml: string, byId: Map<string, FluData>): Promise<string> {
    if (!byId || byId.size === 0) return xml;
    const moddle = new BpmnModdle({ flu: fluModdleDescriptor });
    const { rootElement: defs } = await moddle.fromXML(xml);
    for (const fe of flowElementsOf(defs)) {
        const data = byId.get(fe.id as string);
        if (!data || !hasAny(data)) continue;
        const items = toItems(moddle, data);
        let ext = fe.extensionElements as ModdleElement | undefined;
        if (!ext) {
            ext = moddle.create("bpmn:ExtensionElements", { values: [] });
            fe.extensionElements = ext;
        }
        // Reemplaza cualquier flu:Meta previo (evita duplicados en re-inyección).
        ext.values = (((ext.values as ModdleElement[]) ?? []).filter((v) => v.$type !== "flu:Meta"));
        (ext.values as ModdleElement[]).push(moddle.create("flu:Meta", { items }));
    }
    const { xml: out } = await moddle.toXML(defs, { format: true });
    return out;
}

/** Lee los RCO presentes en el XML, indexados por id de nodo. */
export async function extractFlu(xml: string): Promise<Map<string, FluData>> {
    const map = new Map<string, FluData>();
    if (!xml.includes(":Meta")) return map; // sin datos flu → nada que extraer
    const moddle = new BpmnModdle({ flu: fluModdleDescriptor });
    const { rootElement: defs } = await moddle.fromXML(xml);
    for (const fe of flowElementsOf(defs)) {
        const ext = fe.extensionElements as ModdleElement | undefined;
        const metas = ((ext?.values as ModdleElement[]) ?? []).filter((v) => v.$type === "flu:Meta");
        if (!metas.length) continue;
        const data = emptyFlu();
        for (const m of metas) {
            for (const it of ((m.items as ModdleElement[]) ?? [])) {
                const key = KIND_KEY[(it.kind as keyof typeof KIND_KEY)] ?? "risks";
                data[key].push({ code: it.code as string | undefined, text: (it.text as string) ?? "" });
            }
        }
        if (hasAny(data)) map.set(fe.id as string, data);
    }
    return map;
}

/** Mapa de RCO tomado directo del Contrato A. */
export function fluFromContract(contract: ContractA): Map<string, FluData> {
    const map = new Map<string, FluData>();
    for (const n of contract.nodes) {
        const data: FluData = {
            risks: n.risks ?? [],
            controls: n.controls ?? [],
            opportunities: n.opportunities ?? [],
        };
        if (hasAny(data)) map.set(n.id, data);
    }
    return map;
}
