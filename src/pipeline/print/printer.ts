/**
 * Implementacion de Printer: aplica refs off-page (post-proceso del DI) y
 * calcula el plan de paginas. Layout unico: no re-layoutea.
 *
 * Las refs se dibujan con geometria "tubo" (segmento-bolita ... bolita-segmento)
 * y anti-choque (la bolita camina por la trayectoria original hasta hallar
 * hueco). Ver refs.ts. Que aristas cortar lo decide afuera (ref-cutter).
 */

import { parseDi, serializeDi } from '../contracts/di';
import type { Printer, PrintResult, BpmnXml } from '../contracts/interfaces';
import { applyRefs, relabelRefs, rerouteCrossingLines, orthogonalizeDataAssociations } from './refs';
import { paginate } from './paginate';
import { DEFAULT_RENDER_CONFIG, type RenderConfig } from './render-config';

export interface PrinterOptions {
  /**
   * Re-rutear con A* toda linea que cruce una figura (el layouter a veces las
   * dibuja atravesando cajas). Default true. Ver rerouteCrossingLines.
   *
   * NOTA: el texto largo NO se trunca en el XML (los nombres quedan completos,
   * por compatibilidad con otros BPMN). El "…" es solo visual, en el editor.
   */
  reroute?: boolean;
}

export class DiPrinter implements Printer {
  readonly config: RenderConfig;
  readonly reroute: boolean;

  constructor(config: RenderConfig = DEFAULT_RENDER_CONFIG, opts: PrinterOptions = {}) {
    this.config = config;
    this.reroute = opts.reroute ?? true;
  }

  async prepare(laidOutBpmn: BpmnXml, cutEdgeIds: Set<string> = new Set()): Promise<PrintResult> {
    const di = await parseDi(laidOutBpmn);
    const refsResult = applyRefs(di, cutEdgeIds);
    relabelRefs(di); // renumerar TODOS los refs (A,B,C...) por orden de lectura
    if (this.reroute) rerouteCrossingLines(di); // arreglar lineas que cruzan figuras
    if (this.reroute) orthogonalizeDataAssociations(di); // tambores: puntedas ortogonales + A*
    const pages = paginate(di, this.config.pagination);
    const xml = await serializeDi(di);
    return { xml, pages, refs: refsResult.pairs };
  }
}
