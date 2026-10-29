/**
 * Declaracion minima para bpmn-auto-layout@2.x-alpha (no publica tipos).
 * API confirmada por inspeccion del dist: layoutProcess(xml) => { xml, warnings }.
 */
declare module 'bpmn-auto-layout' {
  export interface LayoutResult {
    xml: string;
    warnings: unknown[];
  }
  export function layoutProcess(xml: string): Promise<LayoutResult>;
  export class LayoutError extends Error {}
  export class LayoutWarning extends Error {}
}
