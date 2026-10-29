/**
 * Implementacion de Layouter basada en bpmn-auto-layout (2.x-alpha).
 *
 * Es la UNICA parte del codigo que importa bpmn-auto-layout. Si manana se
 * reemplaza por un layouter propio (el plan B del handoff: calcular geometria a
 * mano y serializar con bpmn-moddle), se agrega otra clase que implemente
 * Layouter y se cambia una sola linea en la composicion. El resto del sistema
 * habla con la interfaz, nunca con la libreria.
 */

import { layoutProcess } from 'bpmn-auto-layout';
import type { Layouter, LayoutResult, BpmnXml } from '../contracts/interfaces';

export class AutoLayouter implements Layouter {
  async layout(semanticBpmn: BpmnXml): Promise<LayoutResult> {
    const { xml, warnings } = await layoutProcess(semanticBpmn);
    return {
      xml,
      warnings: (warnings ?? []).map((w) => (w as Error)?.message ?? String(w)),
    };
  }
}

/** Instancia por defecto lista para usar. */
export const defaultLayouter: Layouter = new AutoLayouter();
