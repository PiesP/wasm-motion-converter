// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFile } from 'node:fs/promises';

export type ProcessMemorySource = 'smaps_rollup' | 'status' | 'unavailable';

export interface ProcessMemoryReading {
  pssMB: number | null;
  rssMB: number | null;
  pssSource: ProcessMemorySource;
  rssSource: ProcessMemorySource;
  errors: string[];
}

export interface ProcessMemoryEntry {
  id: number;
  type: string;
  memory: ProcessMemoryReading;
}

export interface ProcessMemorySummary {
  pssMB: number | null;
  rssMB: number | null;
  processCount: number;
  pssProcessCount: number;
  rssProcessCount: number;
  sources: {
    pss: Record<ProcessMemorySource, number>;
    rss: Record<ProcessMemorySource, number>;
  };
  byType: Record<
    string,
    {
      count: number;
      pssMB: number | null;
      rssMB: number | null;
      pssProcessCount: number;
      rssProcessCount: number;
    }
  >;
  missing: Array<{
    id: number;
    type: string;
    pssSource: ProcessMemorySource;
    rssSource: ProcessMemorySource;
    errors: string[];
  }>;
}

type ReadTextFile = (path: string) => Promise<string>;

function readKilobytes(text: string, field: string): number | null {
  const match = text.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm'));
  return match ? Number(match[1]) / 1024 : null;
}

export async function readLinuxProcessMemory(
  pid: number,
  readTextFile: ReadTextFile = (path) => readFile(path, 'utf8'),
): Promise<ProcessMemoryReading> {
  const errors: string[] = [];
  let pssMB: number | null = null;
  let rssMB: number | null = null;
  let pssSource: ProcessMemorySource = 'unavailable';
  let rssSource: ProcessMemorySource = 'unavailable';

  try {
    const rollup = await readTextFile(`/proc/${pid}/smaps_rollup`);
    pssMB = readKilobytes(rollup, 'Pss');
    rssMB = readKilobytes(rollup, 'Rss');
    if (pssMB === null) errors.push('smaps_rollup: missing Pss');
    else pssSource = 'smaps_rollup';
    if (rssMB === null) errors.push('smaps_rollup: missing Rss');
    else rssSource = 'smaps_rollup';
  } catch {
    errors.push('smaps_rollup: read failed');
  }

  if (rssMB === null) {
    try {
      const status = await readTextFile(`/proc/${pid}/status`);
      rssMB = readKilobytes(status, 'VmRSS');
      if (rssMB === null) errors.push('status: missing VmRSS');
      else rssSource = 'status';
    } catch {
      errors.push('status: read failed');
    }
  }

  return { pssMB, rssMB, pssSource, rssSource, errors };
}

function addAvailable(total: number | null, value: number | null): number | null {
  return total === null || value === null ? null : total + value;
}

export function summarizeProcessMemory(processes: ProcessMemoryEntry[]): ProcessMemorySummary {
  const byType: ProcessMemorySummary['byType'] = {};
  const missing: ProcessMemorySummary['missing'] = [];
  const sources: ProcessMemorySummary['sources'] = {
    pss: { smaps_rollup: 0, status: 0, unavailable: 0 },
    rss: { smaps_rollup: 0, status: 0, unavailable: 0 },
  };

  for (const process of processes) {
    const current = byType[process.type] ?? {
      count: 0,
      pssMB: 0,
      rssMB: 0,
      pssProcessCount: 0,
      rssProcessCount: 0,
    };
    current.count++;
    current.pssMB = addAvailable(current.pssMB, process.memory.pssMB);
    current.rssMB = addAvailable(current.rssMB, process.memory.rssMB);
    if (process.memory.pssMB !== null) current.pssProcessCount++;
    if (process.memory.rssMB !== null) current.rssProcessCount++;
    sources.pss[process.memory.pssSource]++;
    sources.rss[process.memory.rssSource]++;
    byType[process.type] = current;

    if (process.memory.pssMB === null || process.memory.rssMB === null) {
      missing.push({
        id: process.id,
        type: process.type,
        pssSource: process.memory.pssSource,
        rssSource: process.memory.rssSource,
        errors: process.memory.errors,
      });
    }
  }

  const hasProcesses = processes.length > 0;
  return {
    pssMB: hasProcesses
      ? processes.reduce<number | null>(
          (total, process) => addAvailable(total, process.memory.pssMB),
          0,
        )
      : null,
    rssMB: hasProcesses
      ? processes.reduce<number | null>(
          (total, process) => addAvailable(total, process.memory.rssMB),
          0,
        )
      : null,
    processCount: processes.length,
    pssProcessCount: processes.filter((process) => process.memory.pssMB !== null).length,
    rssProcessCount: processes.filter((process) => process.memory.rssMB !== null).length,
    sources,
    byType,
    missing,
  };
}
