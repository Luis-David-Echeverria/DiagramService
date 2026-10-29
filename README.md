# Pipeline BPMN de Flu3nce

Código extraído del editor web de Flu3nce para que el backend pueda reproducir el mismo diagrama y comprender qué admite el layout actual. El BPMN 2.0 XML con DI es el archivo editable; `Contrato A` es una proyección lógica sin coordenadas. El paquete no llama a la API de Flu3nce ni decide qué proceso describe una conversación.

## Probarlo

```bash
npm install
npm test
```

`tests/pipeline.cjs` genera un BPMN con posiciones a partir de `examples/simple-process.json`, lo vuelve a leer como `Contrato A` y comprueba que se conservaron el proceso y sus nodos. La entrada está descrita en `src/pipeline/contracts/contract-a.schema.json`.

```ts
import { generateDiagram, bpmnToContract, updateReferences } from "flu3nce-bpmn-pipeline";

const result = await generateDiagram(contractA, { refMaxLenPx: 600 });
// result.xml: BPMN 2.0 con DI, lanes, nodos y flujos; warnings, stats, refs, pagination.
const logical = await bpmnToContract(result.xml);
const afterEditing = await updateReferences(editedBpmnXml, 600);
```

`examples/browser-worker.ts` muestra cómo el front ejecuta estas operaciones fuera del hilo de la interfaz. Para usarlo en un servicio Node, importa las funciones del paquete directamente; no necesitas el worker.

## Qué hace cada módulo

1. `ingest/validate.ts` verifica IDs, referencias y continuidad básica del grafo.
2. `ingest/build-bpmn.ts` genera semántica BPMN sin posiciones. Usa una colaboración con participante, proceso y carriles para que `bpmn-auto-layout` coloque los carriles.
3. `layout/auto-layouter.ts` llama a `bpmn-auto-layout@2.0.0-alpha.2` y produce BPMN DI.
4. `print/ref-cutter.ts`, `print/refs.ts` y `print/printer.ts` convierten conexiones largas en referencias, corrigen algunos cruces y calculan páginas de impresión.
5. `flu-ext.ts` preserva riesgos, controles y oportunidades en `flu:extensionElements`. Se extraen antes de una nueva pasada por el layouter y se reinyectan después.
6. `bpmn-to-contract.ts` recupera el grafo lógico del BPMN, también al leer referencias fuera de página.

## Límites que importan al integrarlo

- El vocabulario de `Contrato A` es cerrado: inicio, fin, tareas genéricas/de usuario/de servicio y compuertas exclusivas o paralelas. No conviertas otros elementos BPMN a uno de esos tipos por aproximación; ampliar el vocabulario requiere un cambio explícito de entrada y de ida/vuelta.
- Se usa la versión **2.0.0-alpha.2** de `bpmn-auto-layout` porque el layout de colaboración, participante y carriles que necesita este pipeline no funciona con la versión estable 1.3.0. La librería asigna geometría, no interpreta documentos ni garantiza legibilidad en todos los grafos grandes. El printer hace correcciones adicionales de líneas y referencias; devuelve `warnings` para revisar el resultado.
- `relayoutDiagram` recalcula la geometría. **No** lo ejecutes al guardar o modificar una versión del editor si hay posiciones movidas manualmente. El XML editado es la fuente de esas posiciones; `updateReferences` conserva el layout cuando solo cambian las referencias.
- `bpmn-auto-layout` puede eliminar extensiones que no conoce al reserializar. Para `flu:` es obligatorio extraer y reinyectar. Si el backend añade otros namespaces, debe preservarlos también.
- El paquete produce XML y metadatos de paginación. El visor y la exportación visual a PDF son responsabilidades aparte; no confundas un PDF de vista con el BPMN editable.
- El esquema JSON de este repositorio incluye `schemaVersion: "contrato-a"` para coincidir con el tipo y con el BPMN que devuelve el editor. La validación de grafo es adicional a la validación del JSON Schema.

El código procede de `src/components/custom/bpmn-editor/pipeline`, `flu-ext.ts` y `bpmn-to-contract.ts` del front. Los cambios que se hagan aquí deben compararse con el editor antes de actualizar la versión usada por el backend.
