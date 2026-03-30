/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { DatasetAdapter, TestCase } from '../types';

const DATASET_URL =
  'https://datasets-server.huggingface.co/rows?dataset=PELAB-LiU%2FText2VQL&config=default&split=test&offset=0&length=100';

interface Text2VQLRow {
  row: {
    id: number;
    nl: string;
    pattern: string;
    metamodel: string;
    metamodel_definition: string;
    split: string;
  };
}

interface Text2VQLResponse {
  rows: Text2VQLRow[];
}

function parseMetamodelEntities(definition: string): string[] {
  const entities = new Set<string>();
  // Match class-like declarations: "ClassName {" or "class ClassName"
  const classPattern = /(?:class\s+|^)([A-Z][A-Za-z0-9_]*)\s*[{(]/gmu;
  for (const match of definition.matchAll(classPattern)) {
    if (match[1] !== undefined) {
      entities.add(match[1]);
    }
  }
  // Also match standalone capitalized identifiers that look like class names
  const standalonePattern = /^([A-Z][A-Za-z0-9_]*)\s*$/gmu;
  for (const match of definition.matchAll(standalonePattern)) {
    if (match[1] !== undefined) {
      entities.add(match[1]);
    }
  }
  return [...entities];
}

function parseMetamodelRelations(definition: string): string[] {
  const relations = new Set<string>();
  // Match reference-like patterns: "Type referenceName" or "referenceName : Type"
  const refPattern =
    /([A-Z][A-Za-z0-9_]*(?:\[\d*\.\.\d*\])?)\s+([a-z][A-Za-z0-9_]*)\s*$/gmu;
  for (const match of definition.matchAll(refPattern)) {
    if (match[2] !== undefined) {
      relations.add(match[2]);
    }
  }
  return [...relations];
}

export const text2vqlAdapter: DatasetAdapter = {
  name: 'text2vql',

  async download(cacheDir: string): Promise<void> {
    const dataFile = join(cacheDir, 'text2vql', 'data.json');
    if (existsSync(dataFile)) {
      return;
    }
    console.log('[text2vql] Fetching dataset from HuggingFace...');
    mkdirSync(join(cacheDir, 'text2vql'), { recursive: true });

    const response = await fetch(DATASET_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Text2VQL dataset: ${response.status} ${response.statusText}`,
      );
    }
    const data = await response.text();
    writeFileSync(dataFile, data, 'utf-8');
    console.log('[text2vql] Dataset cached.');
  },

  async loadTestCases(
    cacheDir: string,
    sampleSize: number,
  ): Promise<TestCase[]> {
    const dataFile = join(cacheDir, 'text2vql', 'data.json');
    if (!existsSync(dataFile)) {
      throw new Error(
        `Text2VQL data not found at ${dataFile}. Run download first.`,
      );
    }

    const raw = readFileSync(dataFile, 'utf-8');
    const data = JSON.parse(raw) as Text2VQLResponse;
    const testCases: TestCase[] = [];

    // Group by metamodel to get diverse coverage
    const byMetamodel = new Map<string, Text2VQLRow[]>();
    for (const row of data.rows) {
      const key = row.row.metamodel;
      const existing = byMetamodel.get(key) ?? [];
      existing.push(row);
      byMetamodel.set(key, existing);
    }

    // Take one per metamodel first for diversity, then fill
    const sortedMetamodels = [...byMetamodel.keys()].sort();
    for (const metamodel of sortedMetamodels) {
      const rows = byMetamodel.get(metamodel) ?? [];
      for (const row of rows) {
        const entities = parseMetamodelEntities(row.row.metamodel_definition);
        const relations = parseMetamodelRelations(row.row.metamodel_definition);

        // Build a descriptive prompt from the NL query and metamodel context
        const prompt = `Given a domain about "${metamodel}": ${row.row.nl}`;

        testCases.push({
          id: `text2vql-${row.row.id}`,
          source: 'text2vql',
          naturalLanguageInput: prompt,
          expected: {
            entities,
            relations,
          },
        });
      }
    }

    return testCases.slice(0, sampleSize);
  },
};
