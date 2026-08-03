import { performance } from "node:perf_hooks";
import {
  parseMarkdownSourceSpans,
  renderSafeMarkdown,
} from "../src/augments/safe-markdown.js";

const SAMPLE_COUNT = 25;
const WARMUP_COUNT = 3;
const MAX_MEDIAN_GROWTH = 40;
const MARKDOWN_PERF_CHUNK = [
  "## Representative heading",
  "",
  "A paragraph with **bold**, `code`, and https://example.com/path?q=1.",
  "",
  "- first list item",
  "- second list item",
  "",
  "| name | value |",
  "| --- | ---: |",
  "| alpha | 123 |",
  "",
].join("\n");

interface TimingSummary {
  medianMs: number;
  p95Ms: number;
}

function markdownFixture(bytes: number): string {
  return MARKDOWN_PERF_CHUNK.repeat(
    Math.ceil(bytes / MARKDOWN_PERF_CHUNK.length),
  ).slice(0, bytes);
}

function percentile(sortedTimings: readonly number[], fraction: number): number {
  return sortedTimings[Math.ceil(sortedTimings.length * fraction) - 1] ?? 0;
}

function measure(operation: () => void): TimingSummary {
  for (let index = 0; index < WARMUP_COUNT; index += 1) operation();

  const timings: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    operation();
    timings.push(performance.now() - startedAt);
  }
  timings.sort((left, right) => left - right);

  return {
    medianMs: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
  };
}

const measurements = [16 * 1024, 256 * 1024].map((bytes) => {
  const markdown = markdownFixture(bytes);
  const parse = measure(() => parseMarkdownSourceSpans(markdown));
  const render = measure(() => renderSafeMarkdown(markdown));

  console.log(
    `MARKDOWN_PERF: bytes=${bytes} samples=${SAMPLE_COUNT} parse_median_ms=${parse.medianMs.toFixed(2)} parse_p95_ms=${parse.p95Ms.toFixed(2)} render_median_ms=${render.medianMs.toFixed(2)} render_p95_ms=${render.p95Ms.toFixed(2)}`,
  );

  return { bytes, parse, render };
});

const [small, large] = measurements;
if (!small || !large) throw new Error("Markdown benchmark cases are missing");

const parseGrowth = large.parse.medianMs / small.parse.medianMs;
const renderGrowth = large.render.medianMs / small.render.medianMs;
console.log(
  `MARKDOWN_PERF_GROWTH: input=${large.bytes / small.bytes}x parse_median=${parseGrowth.toFixed(2)}x render_median=${renderGrowth.toFixed(2)}x limit=${MAX_MEDIAN_GROWTH}x`,
);

if (parseGrowth >= MAX_MEDIAN_GROWTH) {
  throw new Error(
    `Markdown positioned-parse median grew ${parseGrowth.toFixed(2)}x for a ${large.bytes / small.bytes}x input`,
  );
}
if (renderGrowth >= MAX_MEDIAN_GROWTH) {
  throw new Error(
    `Markdown safe-render median grew ${renderGrowth.toFixed(2)}x for a ${large.bytes / small.bytes}x input`,
  );
}
