#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RefineryChat } from '@tools.refinery/client/chat';
import type {
  TextToModelPipelineResult,
  TextToModelPipelineStatus,
} from '@tools.refinery/client/chat';

import adapters from './adapters';
import { computeMetrics } from './metrics';
import { writeReport } from './report';
import type {
  DatasetName,
  EvalConfig,
  EvalResult,
  EvalStages,
  TestCase,
} from './types';

const ALL_DATASETS: DatasetName[] = [
  'userStories',
  'text2vql',
  'modelSet',
  'zenodo',
];

function parseConfig(): EvalConfig {
  const { values } = parseArgs({
    options: {
      datasets: { type: 'string', short: 'd', default: 'userStories' },
      'sample-size': { type: 'string', short: 'n', default: '10' },
      'candidate-count': { type: 'string', short: 'c', default: '3' },
      'output-dir': {
        type: 'string',
        short: 'o',
        default: './eval-results',
      },
      'chat-base-url': {
        type: 'string',
        default: 'http://localhost:1314/chat/v1',
      },
      'cache-dir': {
        type: 'string',
        default: './eval-datasets',
      },
      'download-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: npx tsx subprojects/chat/src/eval/harness.ts [options]

Options:
  -d, --datasets <names>        Comma-separated dataset names (default: userStories)
                                Available: ${ALL_DATASETS.join(', ')}
  -n, --sample-size <number>    Max test cases per dataset (default: 10)
  -c, --candidate-count <num>   Pipeline candidate count (default: 3)
  -o, --output-dir <path>       Output directory for results (default: ./eval-results)
      --chat-base-url <url>     Chat server URL (default: http://localhost:1314/chat/v1)
      --cache-dir <path>        Dataset cache directory (default: ./eval-datasets)
      --download-only           Only download datasets, don't run evaluation
  -h, --help                    Show this help message
`);
    process.exit(0);
  }

  const datasetNames = (values.datasets ?? 'userStories')
    .split(',')
    .map((s) => s.trim()) as DatasetName[];
  for (const name of datasetNames) {
    if (!ALL_DATASETS.includes(name)) {
      console.error(
        `Unknown dataset: ${name}. Available: ${ALL_DATASETS.join(', ')}`,
      );
      process.exit(1);
    }
  }

  return {
    datasets: datasetNames,
    sampleSize: parseInt(values['sample-size'] ?? '10', 10),
    candidateCount: parseInt(values['candidate-count'] ?? '3', 10),
    outputDir: resolve(values['output-dir'] ?? './eval-results'),
    chatBaseURL: values['chat-base-url'] ?? 'http://localhost:1314/chat/v1',
    datasetCacheDir: resolve(values['cache-dir'] ?? './eval-datasets'),
  };
}

async function downloadDatasets(config: EvalConfig): Promise<void> {
  mkdirSync(config.datasetCacheDir, { recursive: true });

  for (const datasetName of config.datasets) {
    const adapter = adapters[datasetName];
    console.log(`\n[${adapter.name}] Downloading dataset...`);
    await adapter.download(config.datasetCacheDir);
    console.log(`[${adapter.name}] Download complete.`);
  }
}

async function loadAllTestCases(config: EvalConfig): Promise<TestCase[]> {
  const allCases: TestCase[] = [];

  for (const datasetName of config.datasets) {
    const adapter = adapters[datasetName];
    console.log(`[${adapter.name}] Loading test cases...`);
    const cases = await adapter.loadTestCases(
      config.datasetCacheDir,
      config.sampleSize,
    );
    console.log(`[${adapter.name}] Loaded ${cases.length} test cases.`);
    allCases.push(...cases);
  }

  return allCases;
}

async function evaluateSingle(
  client: RefineryChat,
  testCase: TestCase,
  config: EvalConfig,
): Promise<EvalResult> {
  const stages: EvalStages = {};
  const startTime = Date.now();

  try {
    let currentStage: string | undefined;
    let stageStart = Date.now();

    const result: TextToModelPipelineResult = await client.textToModelPipeline(
      {
        metamodel: { source: testCase.metamodelSource ?? '' },
        text: testCase.naturalLanguageInput,
        candidateCount: config.candidateCount,
        format: {
          source: { enabled: true },
          json: {
            enabled: true,
            nonExistingObjects: 'discard',
            shadowPredicates: 'keep',
          },
        },
      },
      {
        onStatus: (status: TextToModelPipelineStatus) => {
          // Track stage transitions
          if (status.stage !== currentStage) {
            if (currentStage !== undefined) {
              const duration = Date.now() - stageStart;
              switch (currentStage) {
                case 'extract':
                  stages.extractDomain = { success: true, duration };
                  break;
                case 'structure':
                  stages.structure = { success: true, duration };
                  break;
                case 'predicates':
                case 'concretize':
                case 'preview':
                  if (stages.predicates === undefined) {
                    stages.predicates = { success: true, duration };
                  } else {
                    stages.predicates.duration += duration;
                  }
                  break;
                case 'candidates':
                  stages.candidates = { success: true, duration };
                  break;
                case 'critique':
                case 'aggregate':
                  if (stages.critique === undefined) {
                    stages.critique = { success: true, duration };
                  } else {
                    stages.critique.duration += duration;
                  }
                  break;
              }
            }
            currentStage = status.stage;
            stageStart = Date.now();
          }
        },
      },
    );

    // Record final stage
    if (currentStage !== undefined) {
      const duration = Date.now() - stageStart;
      if (currentStage === 'aggregate' || currentStage === 'critique') {
        if (stages.critique === undefined) {
          stages.critique = { success: true, duration };
        } else {
          stages.critique.duration += duration;
        }
      }
    }

    // Fill in stage details from result
    if (stages.extractDomain !== undefined) {
      stages.extractDomain.output = result.extractedDomain;
    }
    if (stages.structure !== undefined) {
      stages.structure.output = result.structureSource;
    }
    if (stages.candidates !== undefined) {
      stages.candidates.count = result.candidates.length;
    }
    if (stages.critique !== undefined) {
      stages.critique.findings = result.findings;
    }

    const metrics = computeMetrics(
      testCase,
      result,
      result.extractedDomain,
    );

    return {
      testCase,
      stages,
      finalResult: result,
      metrics,
      totalDuration: Date.now() - startTime,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    return {
      testCase,
      stages,
      metrics: {
        syntacticValidity: false,
        semanticValidity: false,
      },
      error: errorMessage,
      totalDuration: Date.now() - startTime,
    };
  }
}

async function runEvaluation(config: EvalConfig): Promise<void> {
  console.log('=== Text-to-Model Pipeline Evaluation ===\n');
  console.log(`Datasets: ${config.datasets.join(', ')}`);
  console.log(`Sample size: ${config.sampleSize} per dataset`);
  console.log(`Candidate count: ${config.candidateCount}`);
  console.log(`Chat server: ${config.chatBaseURL}\n`);

  // Download datasets
  await downloadDatasets(config);

  // Load test cases
  const testCases = await loadAllTestCases(config);
  console.log(`\nTotal test cases: ${testCases.length}\n`);

  if (testCases.length === 0) {
    console.log('No test cases found. Exiting.');
    return;
  }

  // Create client
  const client = new RefineryChat({ baseURL: config.chatBaseURL });

  // Run evaluations sequentially (each is an LLM call)
  const results: EvalResult[] = [];
  for (let i = 0; i < testCases.length; i += 1) {
    const testCase = testCases[i]!;
    const progress = `[${i + 1}/${testCases.length}]`;
    const truncatedInput = testCase.naturalLanguageInput.length > 60
      ? `${testCase.naturalLanguageInput.slice(0, 57)}...`
      : testCase.naturalLanguageInput;
    console.log(`${progress} ${testCase.id}: ${truncatedInput}`);

    const result = await evaluateSingle(client, testCase, config);

    if (result.error !== undefined) {
      console.log(`  ❌ ERROR: ${result.error}`);
    } else {
      const m = result.metrics;
      const parts = [
        m.syntacticValidity ? 'syntax:✓' : 'syntax:✗',
        m.semanticValidity ? 'semantic:✓' : 'semantic:✗',
      ];
      if (m.entityF1 !== undefined) {
        parts.push(`entityF1:${m.entityF1.toFixed(2)}`);
      }
      if (m.relationF1 !== undefined) {
        parts.push(`relF1:${m.relationF1.toFixed(2)}`);
      }
      parts.push(`${(result.totalDuration / 1000).toFixed(1)}s`);
      console.log(`  ✓ ${parts.join(' | ')}`);
    }

    results.push(result);
  }

  // Write report
  mkdirSync(config.outputDir, { recursive: true });
  writeReport(results, config);
}

// Main entry point
const config = parseConfig();

// Check for download-only mode
const downloadOnly = process.argv.includes('--download-only');

if (downloadOnly) {
  downloadDatasets(config)
    .then(() => {
      console.log('\nAll datasets downloaded.');
    })
    .catch((err: unknown) => {
      console.error('Download failed:', err);
      process.exit(1);
    });
} else {
  runEvaluation(config).catch((err: unknown) => {
    console.error('Evaluation failed:', err);
    process.exit(1);
  });
}
