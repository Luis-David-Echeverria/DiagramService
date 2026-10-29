/**
 * Contratos entre modulos. Este archivo es el corazon del desacople: define
 * las INTERFACES que cada modulo implementa, para que sean reemplazables sin
 * tocar a los demas. Ninguna implementacion concreta se importa aca.
 *
 * Flujo:
 *   Contrato A ──[Ingestor]──▶ BPMN semantico ──[Layouter]──▶ BPMN+DI
 *      ──[Printer]──▶ BPMN+DI+refs + PagePlan ──[Exporter]──▶ bytes
 */

import type { ContractA } from './contract-a';

/** BPMN 2.0 XML como string. Formato de intercambio entre casi todos los modulos. */
export type BpmnXml = string;

// ─────────────────────────────────────────────────────────────────────────────
// INGESTA: una fuente de datos -> Contrato A -> BPMN semantico (sin geometria)
// ─────────────────────────────────────────────────────────────────────────────

/** Convierte una fuente (Excel, JSON, API...) en el Contrato A canonico. */
export interface Ingestor<Source> {
  ingest(source: Source): Promise<ContractA> | ContractA;
}

/** Construye BPMN 2.0 semantico (nodos, lanes, flujos) SIN posiciones. */
export interface SemanticBuilder {
  build(contract: ContractA): Promise<BpmnXml> | BpmnXml;
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT: BPMN semantico -> BPMN con DI (posiciones + waypoints)
// ─────────────────────────────────────────────────────────────────────────────

export interface LayoutResult {
  xml: BpmnXml;
  warnings: string[];
}

/**
 * Asigna geometria a un BPMN. Hoy lo implementa bpmn-auto-layout; manana
 * podria ser un layouter propio. Quien lo use NO debe depender de la impl.
 */
export interface Layouter {
  layout(semanticBpmn: BpmnXml): Promise<LayoutResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRINT: plan de paginas (las refs off-page son nativas del layout)
// ─────────────────────────────────────────────────────────────────────────────

export interface PageCell {
  col: number;
  row: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PagePlan {
  enabled: boolean;
  pageSize: { key: string; width: number; height: number };
  cols: number;
  rows: number;
  colBreaks: number[];
  rowBreaks: number[];
  pages: PageCell[];
  shapePage: Record<string, string>;
  hasOversizedNode: boolean;
}

/** Parametros fisicos de una hoja, en px del espacio del DI (@96dpi). */
export interface PageSpec {
  key: string; // 'carta' | 'a4' | 'tabloide' | ...
  width: number; // ancho util ya con margenes descontados
  height: number;
  marginPx: number;
}

/**
 * Calcula COMO se reparte un diagrama en hojas fisicas. Distintas estrategias
 * de corte (geometrica, por fases, por carriles) son implementaciones
 * intercambiables de esta interfaz. Recibe la geometria del DI y una hoja
 * fisica; devuelve el plan (que nodo cae en que hoja, cortes, etc.).
 *
 * NO modifica el diagrama: solo lee y decide. El diagrama nunca se deforma.
 */
export interface Paginator {
  readonly strategy: string; // 'grid' | 'phases' | 'lanes' | ...
  paginate(input: PaginationInput): PagePlan;
}

/** Entrada al Paginator: cajas del contenido + la hoja fisica objetivo. */
export interface PaginationInput {
  /** Cajas de los nodos (sin pool ni lanes), en coords del DI. */
  boxes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  page: PageSpec;
}

export interface RefPair {
  code: string;
  from: string;
  to: string;
  lengthPx: number;
}

export interface PrintResult {
  /** BPMN con el DI (refs off-page aplicadas como post-proceso). */
  xml: BpmnXml;
  pages: PagePlan;
  /** Refs off-page creadas. */
  refs: RefPair[];
}

/**
 * Prepara un BPMN+DI para impresion autocontenida: reemplaza aristas "feas"
 * por conectores off-page y calcula el plan de paginas. Cada pagina debe
 * entenderse sola (requisito del negocio: nada de "juntar 8 hojas en la pared").
 */
export interface Printer {
  /** @param cutEdgeIds ids de aristas a convertir en refs off-page. */
  prepare(laidOutBpmn: BpmnXml, cutEdgeIds?: Set<string>): Promise<PrintResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: BPMN+DI -> bytes de un formato (PDF, VSDX, PNG...)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportArtifact {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Exporta un BPMN a un formato concreto. Aspose, PDF libre, VSDX libre son
 * implementaciones intercambiables. El editor NO sabe como se exporta.
 */
export interface Exporter {
  readonly format: string; // 'pdf' | 'vsdx' | 'png' | ...
  export(bpmn: BpmnXml, options?: Record<string, unknown>): Promise<ExportArtifact>;
}
