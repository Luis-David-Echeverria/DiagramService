/** Ejemplo mínimo del adaptador que usa el editor web. No forma parte del build Node. */
import { generateDiagram, relayoutDiagram, updateReferences, type ContractA } from "../src/index";

self.onmessage = async (event: MessageEvent) => {
  const { id, op, contract, xml, refMaxLenPx, forceRef, forceLine } = event.data as {
    id: string; op: "generate" | "layout" | "reref"; contract?: ContractA;
    xml?: string; refMaxLenPx?: number; forceRef?: string[]; forceLine?: string[];
  };
  try {
    const result = op === "generate" && contract ? await generateDiagram(contract, { refMaxLenPx })
      : op === "layout" && xml ? await relayoutDiagram(xml, refMaxLenPx, forceRef, forceLine)
      : op === "reref" && xml ? await updateReferences(xml, refMaxLenPx, forceRef, forceLine)
      : (() => { throw new Error("Operación o entrada inválida"); })();
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: (error as Error).message });
  }
};
