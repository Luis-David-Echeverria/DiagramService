/**
 * Tipos del Contrato A (Etapa 1 -> Etapa 2).
 * Reflejan contracts/contract-a.schema.json. El JSON Schema es la fuente de
 * verdad; estos tipos son la vista de TypeScript sobre el mismo contrato.
 */

export type NodeType =
  | 'startEvent'
  | 'endEvent'
  | 'userTask'
  | 'serviceTask'
  | 'task'
  | 'exclusiveGateway'
  | 'parallelGateway';

export interface Lane {
  id: string;
  name: string;
  order: number;
}

/**
 * Sistema / base de datos (el "tambor"). Se dibuja como cilindro nativo
 * (bpmn:DataStoreReference) y se liga a las actividades con líneas punteadas
 * (DataInput/OutputAssociation). Compartido: un cilindro por sistema.
 */
export interface DataStore {
  id: string;
  name: string;
}

/**
 * Riesgo / control / oportunidad asociado a una actividad. Es una capa GRC
 * sobre el flujo (BPMN no la modela nativamente): viaja como extensionElements
 * bajo el namespace `flu:` y se dibuja como badge en Fluence, sin ensuciar el
 * modelo BPMN estandar. Ver flu-ext.ts.
 */
export interface RcoItem {
  code?: string;
  text: string;
}

export interface ProcessNode {
  id: string;
  type: NodeType;
  name: string;
  lane: string;
  /** Nota/contexto de la actividad. Nativo BPMN: se emite como bpmn:documentation. */
  description?: string;
  /** Sistemas que la actividad LEE → línea punteada entrante (DataInputAssociation). */
  reads?: string[];
  /** Sistemas que la actividad ESCRIBE → línea punteada saliente (DataOutputAssociation). */
  writes?: string[];
  risks?: RcoItem[];
  controls?: RcoItem[];
  opportunities?: RcoItem[];
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface ContractA {
  schemaVersion: 'contrato-a';
  version: '1.0.0' | '2.0.0';
  process: { id: string; name: string; description?: string };
  lanes: Lane[];
  dataStores?: DataStore[];
  nodes: ProcessNode[];
  edges: Edge[];
}
