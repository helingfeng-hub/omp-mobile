import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionStatus } from "../src/status.js";

test("parses omp footer model and context usage", () => {
  const output = [
    "some transcript",
    "π · ◉ DeepSeek V4.1 Flash 1017 · ⇄ collab:2 · 📁 ~ · ◫ 15.0%/1M ⟲ · $0.08 ↓",
  ].join("\n");
  assert.deepEqual(parseSessionStatus(output), {
    model: "DeepSeek V4.1 Flash 1017",
    context: { percent: 15, percentText: "15.0", window: "1M" },
  });
});

test("parses a compact footer and ignores older lines", () => {
  const output = [
    "old π · ◉ Old Model · ⇄ collab:1 · ◫ 99%/8K",
    "new π · ◉ DeepSeek-V4.1-Flash · ⇄ collab:1 · ◫ 0.9%/1M",
  ].join("\n");
  assert.deepEqual(parseSessionStatus(output), {
    model: "DeepSeek-V4.1-Flash",
    context: { percent: 0.9, percentText: "0.9", window: "1M" },
  });
});

test("returns nulls when the footer is absent", () => {
  assert.deepEqual(parseSessionStatus("plain tmux output\n❯"), {
    model: null,
    context: null,
  });
});
