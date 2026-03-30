/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalResult, EvalConfig } from './types';

interface DatasetSummary {
  dataset: string;
  totalCases: number;
  successCount: number;
  syntaxValidPercent: number;
  semanticValidPercent: number;
  avgEntityF1: number | undefined;
  avgRelationF1: number | undefined;
  avgDuration: number;
}

function summarizeByDataset(results: EvalResult[]): DatasetSummary[] {
  const byDataset = new Map<string, EvalResult[]>();
  for (const result of results) {
    const key = result.testCase.source;
    const existing = byDataset.get(key) ?? [];
    existing.push(result);
    byDataset.set(key, existing);
  }

  const summaries: DatasetSummary[] = [];
  for (const [dataset, datasetResults] of byDataset) {
    const total = datasetResults.length;
    const successCount = datasetResults.filter(
      (r) => r.error === undefined,
    ).length;
    const syntaxValid = datasetResults.filter(
      (r) => r.metrics.syntacticValidity,
    ).length;
    const semanticValid = datasetResults.filter(
      (r) => r.metrics.semanticValidity,
    ).length;

    const entityF1s = datasetResults
      .map((r) => r.metrics.entityF1)
      .filter((v): v is number => v !== undefined);
    const relationF1s = datasetResults
      .map((r) => r.metrics.relationF1)
      .filter((v): v is number => v !== undefined);

    const avgDuration =
      datasetResults.reduce((sum, r) => sum + r.totalDuration, 0) / total;

    summaries.push({
      dataset,
      totalCases: total,
      successCount,
      syntaxValidPercent: total > 0 ? (syntaxValid / total) * 100 : 0,
      semanticValidPercent: total > 0 ? (semanticValid / total) * 100 : 0,
      avgEntityF1:
        entityF1s.length > 0
          ? entityF1s.reduce((a, b) => a + b, 0) / entityF1s.length
          : undefined,
      avgRelationF1:
        relationF1s.length > 0
          ? relationF1s.reduce((a, b) => a + b, 0) / relationF1s.length
          : undefined,
      avgDuration,
    });
  }

  return summaries.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatFloat(value: number | undefined): string {
  return value !== undefined ? value.toFixed(3) : 'N/A';
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function padRight(s: string, len: number): string {
  return s + ' '.repeat(Math.max(0, len - s.length));
}

function padLeft(s: string, len: number): string {
  return ' '.repeat(Math.max(0, len - s.length)) + s;
}

function generateMarkdownSummary(
  results: EvalResult[],
  config: EvalConfig,
): string {
  const summaries = summarizeByDataset(results);
  const timestamp = new Date().toISOString();

  const lines: string[] = [
    '# Text-to-Model Pipeline Evaluation Report',
    '',
    `**Date:** ${timestamp}`,
    `**Datasets:** ${config.datasets.join(', ')}`,
    `**Sample size:** ${config.sampleSize} per dataset`,
    `**Candidate count:** ${config.candidateCount}`,
    `**Chat server:** ${config.chatBaseURL}`,
    '',
    '## Summary',
    '',
    '| Dataset | Cases | Success | Syntax Valid | Semantic Valid | Entity F1 | Relation F1 | Avg Duration |',
    '|---------|-------|---------|-------------|---------------|-----------|-------------|-------------|',
  ];

  for (const s of summaries) {
    lines.push(
      `| ${padRight(s.dataset, 14)} | ${padLeft(String(s.totalCases), 5)} | ${padLeft(String(s.successCount), 7)} | ${padLeft(formatPercent(s.syntaxValidPercent), 11)} | ${padLeft(formatPercent(s.semanticValidPercent), 13)} | ${padLeft(formatFloat(s.avgEntityF1), 9)} | ${padLeft(formatFloat(s.avgRelationF1), 11)} | ${padLeft(formatDuration(s.avgDuration), 11)} |`,
    );
  }

  // Overall stats
  const totalCases = results.length;
  const totalSuccess = results.filter((r) => r.error === undefined).length;
  const totalSyntaxValid = results.filter(
    (r) => r.metrics.syntacticValidity,
  ).length;
  const totalSemanticValid = results.filter(
    (r) => r.metrics.semanticValidity,
  ).length;

  lines.push(
    '',
    '## Overall',
    '',
    `- **Total test cases:** ${totalCases}`,
    `- **Successful runs:** ${totalSuccess} (${((totalSuccess / totalCases) * 100).toFixed(1)}%)`,
    `- **Syntactically valid:** ${totalSyntaxValid} (${((totalSyntaxValid / totalCases) * 100).toFixed(1)}%)`,
    `- **Semantically valid:** ${totalSemanticValid} (${((totalSemanticValid / totalCases) * 100).toFixed(1)}%)`,
  );

  // Failures
  const failures = results.filter((r) => r.error !== undefined);
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const f of failures) {
      lines.push(`- **${f.testCase.id}**: ${f.error}`);
    }
  }

  return lines.join('\n');
}

export function writeReport(
  results: EvalResult[],
  config: EvalConfig,
): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const reportDir = join(config.outputDir, timestamp);
  mkdirSync(reportDir, { recursive: true });

  // Write full results JSON
  writeFileSync(
    join(reportDir, 'results.json'),
    JSON.stringify(results, null, 2),
    'utf-8',
  );

  // Write individual case results
  const perCaseDir = join(reportDir, 'per-case');
  mkdirSync(perCaseDir, { recursive: true });
  for (const result of results) {
    writeFileSync(
      join(perCaseDir, `${result.testCase.id}.json`),
      JSON.stringify(result, null, 2),
      'utf-8',
    );
  }

  // Write markdown summary
  const summary = generateMarkdownSummary(results, config);
  writeFileSync(join(reportDir, 'summary.md'), summary, 'utf-8');

  console.log(`\nReport written to: ${reportDir}`);
  console.log(summary);

  return reportDir;
}
