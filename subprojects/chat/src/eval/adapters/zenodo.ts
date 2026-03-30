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
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';

import type { DatasetAdapter, TestCase } from '../types';

const ZENODO_ZIP_URL =
  'https://zenodo.org/records/2585456/files/manualDomains.zip';

// File naming: ABSINDEX_CLUSTER_ITEMINDEX_name_hash.ecore
// Clusters: bibliography, conference, bugtracker, build, document, requirements, database, statemachine, petrinet
const DOMAIN_LABELS: Record<string, string> = {
  bibliography: 'bibliography management',
  conference: 'conference management',
  bugtracker: 'bug and issue tracking',
  build: 'build system',
  document: 'document and office application',
  requirements: 'requirements and use cases',
  database: 'database and SQL',
  statemachine: 'state machine',
  petrinet: 'Petri net',
};

function parseEcoreXMI(content: string): {
  classes: string[];
  references: string[];
} {
  const classes: string[] = [];
  const references: string[] = [];

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

function parseDomainFromFilename(filename: string): string {
  // Format: ABSINDEX_CLUSTER_ITEMINDEX_name_hash.ecore
  const parts = filename.split('_');
  if (parts.length >= 2) {
    const cluster = parts[1]!.toLowerCase();
    return DOMAIN_LABELS[cluster] ?? cluster;
  }
  return 'unknown';
}

export const zenodoAdapter: DatasetAdapter = {
  name: 'zenodo',

  async download(cacheDir: string): Promise<void> {
    const zenodoDir = join(cacheDir, 'zenodo-ecore');
    const zipFile = join(zenodoDir, 'manualDomains.zip');

    if (existsSync(join(zenodoDir, 'extracted'))) {
      return;
    }

    mkdirSync(zenodoDir, { recursive: true });

    if (!existsSync(zipFile)) {
      console.log('[zenodo] Downloading ZIP from Zenodo...');
      const response = await fetch(ZENODO_ZIP_URL);
      if (!response.ok) {
        throw new Error(
          `Failed to download Zenodo dataset: ${response.status} ${response.statusText}`,
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(zipFile, buffer);
    }

    console.log('[zenodo] Extracting ZIP...');
    const extractDir = join(zenodoDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    // Use platform-appropriate unzip
    try {
      execFileSync('tar', ['-xf', zipFile, '-C', extractDir], {
        stdio: 'inherit',
      });
    } catch {
      // Fallback for Windows
      execFileSync(
        'powershell',
        [
          '-Command',
          `Expand-Archive -Path '${zipFile}' -DestinationPath '${extractDir}' -Force`,
        ],
        { stdio: 'inherit' },
      );
    }
  },

  async loadTestCases(
    cacheDir: string,
    sampleSize: number,
  ): Promise<TestCase[]> {
    const extractDir = join(cacheDir, 'zenodo-ecore', 'extracted');

    if (!existsSync(extractDir)) {
      throw new Error(
        `Zenodo extracted directory not found at ${extractDir}. Run download first.`,
      );
    }

    // Find all .ecore files recursively
    function findEcoreFiles(dir: string): string[] {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findEcoreFiles(fullPath));
        } else if (entry.name.endsWith('.ecore')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const ecoreFiles = findEcoreFiles(extractDir).sort();
    const testCases: TestCase[] = [];

    // Group by domain and sample evenly
    const byDomain = new Map<string, string[]>();
    for (const file of ecoreFiles) {
      const domain = parseDomainFromFilename(basename(file));
      const existing = byDomain.get(domain) ?? [];
      existing.push(file);
      byDomain.set(domain, existing);
    }

    const domains = [...byDomain.keys()].sort();
    const perDomain = Math.max(1, Math.ceil(sampleSize / domains.length));

    for (const domain of domains) {
      const files = byDomain.get(domain) ?? [];

      for (const file of files.slice(0, perDomain)) {
        try {
          const content = readFileSync(file, 'utf-8');
          const { classes, references } = parseEcoreXMI(content);

          if (classes.length < 2) continue;

          const classNames = classes.slice(0, 8).join(', ');
          const prompt = `Create a metamodel for ${domain}. Key concepts include: ${classNames}.`;

          testCases.push({
            id: `zenodo-${basename(file, '.ecore')}`,
            source: 'zenodo',
            naturalLanguageInput: prompt,
            expected: {
              entities: classes,
              relations: references,
            },
          });
        } catch {
          // Skip unparseable files
        }
      }
    }

    return testCases.slice(0, sampleSize);
  },
};
