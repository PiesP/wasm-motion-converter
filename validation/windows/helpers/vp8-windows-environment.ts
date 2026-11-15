/** Guest-scoped, read-only timing environment observations. */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser } from '@playwright/test';

const CPU_QUERY =
  '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors) | ConvertTo-Json -Compress -Depth 3';
const PROCESS_QUERY = (pid: number) =>
  `$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Where-Object { $_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe' } | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress -Depth 3`;
const LOAD_SCRIPT = `$ErrorActionPreference="Stop"; for($i=0;$i -lt 450;$i++){ $sample=Get-Counter -Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction Stop; $value=$sample.CounterSamples[0].CookedValue; [Console]::Out.WriteLine(([DateTime]::UtcNow.ToString('o'))+'|'+([Math]::Round($value,2).ToString([Globalization.CultureInfo]::InvariantCulture))); Start-Sleep -Seconds 2 }`;

function powershell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
    );
  });
}

function rows(raw: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(raw);
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
}

async function executableFingerprint(path: string) {
  const before = await stat(path);
  if (!before.isFile() || before.size <= 0 || before.size > 1024 * 1024 * 1024)
    throw new Error('Browser executable size is outside bound');
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    throw new Error('Browser executable changed while hashing');
  return { sha256: digest, bytes: before.size };
}

async function snapshot(browser: Browser) {
  const cpu = rows(await powershell(CPU_QUERY)).map((row) => ({
    model: row.Name,
    cores: row.NumberOfCores,
    logicalProcessors: row.NumberOfLogicalProcessors,
  }));
  const processes = rows(await powershell(PROCESS_QUERY(process.pid)));
  if (processes.length !== 1)
    throw new Error('Selected browser process is not unique direct child');
  const browserProcess = processes[0]!;
  if (
    typeof browserProcess.ExecutablePath !== 'string' ||
    typeof browserProcess.ProcessId !== 'number'
  )
    throw new Error('Selected browser executable identity is unavailable');
  const fingerprint = await executableFingerprint(browserProcess.ExecutablePath);
  return {
    scope: 'guest',
    guestNodePid: process.pid,
    cpu,
    browser: {
      name: browserProcess.Name,
      pid: browserProcess.ProcessId,
      parentPid: browserProcess.ParentProcessId,
      version: browser.version(),
      ...fingerprint,
    },
  };
}

/** Always reaps the owned sampler; failures become explicit missing evidence. */
export async function withVp8WindowsEnvironment<T>(
  browser: Browser,
  output: string,
  scenario: string,
  operation: () => Promise<T>
): Promise<T> {
  if (process.platform !== 'win32') return operation();
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    scope: 'guest',
    hostNeighborLoad: 'UNOBSERVED',
    before: null,
    after: null,
    load: null,
  };
  try {
    record.before = await snapshot(browser);
  } catch {
    record.beforeError = 'CPU or selected browser identity unavailable';
  }
  const sampler = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', LOAD_SCRIPT],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let load = '';
  let truncated = false;
  let samplerError = false;
  sampler.on('error', () => {
    samplerError = true;
  });
  sampler.stdout?.on('data', (chunk: Buffer) => {
    if (load.length + chunk.length > 64 * 1024) truncated = true;
    else load += chunk.toString('utf8');
  });
  const startedUtc = new Date().toISOString();
  let value: T;
  let reaped = false;
  try {
    value = await operation();
  } finally {
    const endedUtc = new Date().toISOString();
    sampler.kill();
    await new Promise<void>((resolve) => {
      if (sampler.exitCode !== null || sampler.signalCode !== null) {
        reaped = true;
        resolve();
      } else {
        const timer = setTimeout(() => {
          samplerError = true;
          sampler.kill();
          resolve();
        }, 10_000);
        const finish = () => {
          clearTimeout(timer);
          reaped = true;
          resolve();
        };
        sampler.once('exit', finish);
        sampler.once('error', finish);
      }
    });
    if (sampler.exitCode !== null && sampler.exitCode !== 0) samplerError = true;
    try {
      record.after = await snapshot(browser);
    } catch {
      record.afterError = 'CPU or selected browser identity unavailable';
    }
    const samples = load
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [utc, percent] = line.split('|');
        return { utc, guestTotalCpuPercent: Number(percent) };
      });
    record.load = {
      scope: 'guest-total-processor',
      startedUtc,
      endedUtc,
      truncated,
      samplerError,
      reaped,
      samples,
    };
    await writeFile(
      join(output, `${scenario}-timing-environment.json`),
      `${JSON.stringify(record, null, 2)}\n`
    );
  }
  return value;
}
