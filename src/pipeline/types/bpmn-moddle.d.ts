/**
 * Declaracion minima para bpmn-moddle (no publica tipos propios).
 * Solo declaramos lo que usamos.
 */
declare module 'bpmn-moddle' {
  export interface ModdleElement {
    $type: string;
    [key: string]: unknown;
  }

  export interface ToXMLResult {
    xml: string;
  }

  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(element: ModdleElement, options?: { format?: boolean }): Promise<ToXMLResult>;
    fromXML(xml: string): Promise<{ rootElement: ModdleElement; warnings: unknown[] }>;
  }
}
