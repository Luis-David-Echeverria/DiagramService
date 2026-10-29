const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateDiagram, bpmnToContract, updateReferences } = require("../dist/index.js");

test("genera BPMN con layout y recupera el proceso lógico", async () => {
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/simple-process.json"), "utf8"));
  const result = await generateDiagram(contract);
  assert.match(result.xml, /bpmn:definitions/);
  assert.match(result.xml, /bpmndi:BPMNDiagram/);
  assert.equal(result.stats.nodes, 3);
  const restored = await bpmnToContract(result.xml);
  assert.equal(restored.process.name, contract.process.name);
  assert.equal(restored.nodes.length, contract.nodes.length);
  const refs = await updateReferences(result.xml);
  assert.match(refs.xml, /bpmndi:BPMNDiagram/);
});
