/**
 * Pipeline de la Etapa 2, reutilizable por el CLI y por el servidor.
 *
 *   Contrato A (JSON)
 *     -> [ingest]   validar grafo + BPMN semantico sin DI
 *     -> [layout]   Layouter => BPMN con DI
 *     -> [print]    Printer  => refs off-page + plan de paginas
 *     => XML final + metadata de refs y paginas
 *
 * Las etapas de layout y print se reciben como INTERFACES (inyeccion de
 * dependencias). Cambiar bpmn-auto-layout por un layouter propio, o el printer
 * por otro, es cambiar el argumento — no tocar este archivo.
 */

import type { ContractA } from './contracts/contract-a';
import type { Layouter, Printer, PrintResult } from './contracts/interfaces';
import { validateContract } from './ingest/validate';
import { buildSemanticBpmn } from './ingest/build-bpmn';
import { defaultLayouter } from './layout/auto-layouter';
import { DiPrinter } from './print/printer';
import { decideCuts } from './print/ref-cutter';
import { DEFAULT_RENDER_CONFIG, type RenderConfig } from './print/render-config';

export interface PipelineResult {
  xml: string;
  warnings: string[];
  stats: { nodes: number; edges: number; lanes: number };
  refs: PrintResult['refs'];
  pagination: PrintResult['pages'];
}

export interface PipelineDeps {
  config?: RenderConfig;
  layouter?: Layouter;
  printer?: Printer;
  /**
   * Umbral de DISTANCIA en px: toda arista mas larga que esto se vuelve ref
   * off-page. Se mide sobre el layout real. <= 0 = sin refs.
   */
  refMaxLenPx?: number;
  /** Aristas forzadas a ref manualmente (se suman al umbral). */
  forceRefIds?: Set<string>;
  /** Aristas forzadas a linea manualmente (se restan del umbral). */
  forceLineIds?: Set<string>;
}

/** Corre el pipeline completo sobre un Contrato A ya parseado. */
export async function runPipeline(
  contract: ContractA,
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const config = deps.config ?? DEFAULT_RENDER_CONFIG;
  const layouter = deps.layouter ?? defaultLayouter;
  const printer = deps.printer ?? new DiPrinter(config);
  const refMaxLenPx = deps.refMaxLenPx ?? 0;

  validateContract(contract);

  // 1. Layout UNICO (sin refs). Rapido: una sola pasada.
  const { xml: semanticXml } = await buildSemanticBpmn(contract, {});
  const { xml: laidOutXml, warnings } = await layouter.layout(semanticXml);

  // 2. ref-cutter: mide las distancias reales y decide que aristas cortar.
  const auto = refMaxLenPx > 0
    ? (await decideCuts(laidOutXml, refMaxLenPx)).edgeIds
    : new Set<string>();
  // Combinar con los overrides manuales: (auto ∪ forceRef) − forceLine.
  const edgeIds = new Set<string>(auto);
  for (const id of deps.forceRefIds ?? []) edgeIds.add(id);
  for (const id of deps.forceLineIds ?? []) edgeIds.delete(id);

  // 3. Print: aplica los refs como POST-PROCESO del DI (geometria "tubo" con
  //    anti-choque) + plan de paginas. Sin re-layout.
  const { xml, pages, refs } = await printer.prepare(laidOutXml, edgeIds);

  return {
    xml,
    warnings,
    stats: {
      nodes: contract.nodes.length,
      edges: contract.edges.length,
      lanes: contract.lanes.length,
    },
    refs,
    pagination: pages,
  };
}
