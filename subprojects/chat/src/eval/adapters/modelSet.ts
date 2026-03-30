/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';

import type { DatasetAdapter, TestCase } from '../types';

const REPO_URL = 'https://github.com/modelset/modelset-dataset.git';

function parseEcoreXMI(content: string): {
  classes: string[];
  references: string[];
} {
  const classes: string[] = [];
  const references: string[] = [];

  // Extract class names from eClassifiers
  const classPattern = /name="([^"]+)"[^>]*xsi:type="ecore:EClass"/gu;
  const classPattern2 = /xsi:type="ecore:EClass"[^>]*name="([^"]+)"/gu;
  for (const match of content.matchAll(classPattern)) {
    if (match[1] !== undefined) classes.push(match[1]);
  }
  for (const match of content.matchAll(classPattern2)) {
    if (match[1] !== undefined && !classes.includes(match[1])) {
      classes.push(match[1]);
    }
  }

  // Extract reference names
  const refPattern =
    /eStructuralFeatures[^>]*xsi:type="ecore:EReference"[^>]*name="([^"]+)"/gu;
  const refPattern2 =
    /eStructuralFeatures[^>]*name="([^"]+)"[^>]*xsi:type="ecore:EReference"/gu;
  for (const match of content.matchAll(refPattern)) {
    if (match[1] !== undefined) references.push(match[1]);
  }
  for (const match of content.matchAll(refPattern2)) {
    if (match[1] !== undefined && !references.includes(match[1])) {
      references.push(match[1]);
    }
  }

  return { classes, references };
}

function generateSyntheticPrompt(
  classes: string[],
  category: string,
): string {
  const classNames = classes.slice(0, 8).join(', ');
  return `Create a domain model for a ${category} system. The model should include concepts like: ${classNames}.`;
}

export const modelSetAdapter: DatasetAdapter = {
  name: 'modelSet',

  async download(cacheDir: string): Promise<void> {
    const repoDir = join(cacheDir, 'modelset-dataset');
    if (existsSync(join(repoDir, '.git'))) {
      return;
    }
    console.log('[modelSet] Cloning repository (sparse checkout for raw-data/repo-ecore-all)...');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO_URL, repoDir], {
      stdio: 'inherit',
    });
    execFileSync('git', ['-C', repoDir, 'sparse-checkout', 'set', 'raw-data/repo-ecore-all'], {
      stdio: 'inherit',
    });
  },

  async loadTestCases(
    cacheDir: string,
    sampleSize: number,
  ): Promise<TestCase[]> {
    const ecoreDir = join(
      cacheDir,
      'modelset-dataset',
      'raw-data',
      'repo-ecore-all',
    );

    if (!existsSync(ecoreDir)) {
      throw new Error(
        `ModelSet ecore directory not found at ${ecoreDir}. Run download first.`,
      );
    }

    const testCases: TestCase[] = [];
    const subdirs = readdirSync(ecoreDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const subdir of subdirs) {
      const modelDir = join(ecoreDir, subdir);
      const ecoreFiles = readdirSync(modelDir).filter((f) =>
        f.endsWith('.ecore'),
      );

      for (const ecoreFile of ecoreFiles) {
        try {
          const content = readFileSync(join(modelDir, ecoreFile), 'utf-8');
          const { classes, references } = parseEcoreXMI(content);

          if (classes.length < 2) continue;

          const category = subdir.replace(/[-_]/g, ' ');
          const prompt = generateSyntheticPrompt(classes, category);

          testCases.push({
            id: `modelSet-${subdir}-${basename(ecoreFile, '.ecore')}`,
            source: 'modelSet',
            naturalLanguageInput: prompt,
            expected: {
              entities: classes,
              relations: references,
            },
          });
        } catch {
          // Skip files that can't be parsed
        }

        if (testCases.length >= sampleSize) break;
      }
      if (testCases.length >= sampleSize) break;
    }

    return testCases.slice(0, sampleSize);
  },
};
