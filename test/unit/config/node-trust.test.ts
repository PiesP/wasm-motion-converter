import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const workflows = resolve(import.meta.dirname, '../../../.github/workflows');
const trustStep =
  '      - uses: PiesP/browser-core/automation/actions/prepare-node-trust@381b4ca733494cf069212cd0d16458389a83c623';
const trustEnvironment = [
  '  NODE_OPTIONS: --use-openssl-ca',
  '  SSL_CERT_FILE: /etc/ssl/certs/ca-certificates.crt',
  '  SSL_CERT_DIR: /etc/ssl/certs',
];

function jobs(source: string): Array<[string, string]> {
  const markers = [...source.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)];
  const jobsStart = source.search(/^jobs:$/m);
  return markers
    .filter((match) => (match.index ?? -1) > jobsStart)
    .map((match, index, all) => [match[1] ?? '', source.slice(match.index, all[index + 1]?.index)]);
}

describe('runner Node trust before JavaScript actions', () => {
  for (const file of readdirSync(workflows).filter((name) => name.endsWith('.yaml'))) {
    const source = readFileSync(resolve(workflows, file), 'utf8');

    it(`${file} applies the fixed trust environment without overrides`, () => {
      const globalEnvironment = source.match(/^env:\n((?:^  .*(?:\n|$))*)/m)?.[1] ?? '';
      for (const entry of trustEnvironment) {
        expect(globalEnvironment, `${file}: missing global ${entry}`).toContain(entry);
        expect(source.split(entry).length - 1, `${file}: duplicate ${entry}`).toBe(1);
      }
      for (const variable of ['NODE_OPTIONS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        expect(
          [...source.matchAll(new RegExp(`^\\s+${variable}:`, 'gm'))].length,
          `${file}: ${variable} override`
        ).toBe(1);
      }
      expect(source).not.toMatch(/^\s+NODE_EXTRA_CA_CERTS:/m);
      expect(source).not.toMatch(/^\s+NODE_TLS_REJECT_UNAUTHORIZED:/m);
    });

    it(`${file} prepares trust as the unconditional first step of every action job`, () => {
      const parsedJobs = jobs(source);
      expect(parsedJobs.length, `${file}: jobs were not parsed`).toBeGreaterThan(0);
      for (const [name, body] of parsedJobs) {
        const steps = body.match(/^    steps:\n([\s\S]*)/m)?.[1] ?? '';
        expect(steps, `${file}/${name}: missing steps`).not.toBe('');
        const usesAction = /^        uses:/m.test(steps);
        const firstStep = steps.match(/^      - [^\n]+/m)?.[0] ?? '';
        if (usesAction) {
          expect(firstStep, `${file}/${name}: action runs before trust preparation`).toBe(
            trustStep
          );
          expect(steps.split(trustStep).length - 1, `${file}/${name}: duplicate trust step`).toBe(
            1
          );
          const stepMarkers = [...steps.matchAll(/^      - /gm)];
          const firstStepBody = steps.slice(stepMarkers[0]?.index ?? 0, stepMarkers[1]?.index);
          expect(firstStepBody, `${file}/${name}: conditional trust step`).not.toMatch(
            /^\s+(if|continue-on-error):/m
          );
        } else {
          expect(steps, `${file}/${name}: shell-only job has a trust step`).not.toContain(
            'prepare-node-trust@'
          );
        }
        if (name === 'security-summary') {
          expect(usesAction, `${file}/${name}: expected a shell-only summary`).toBe(false);
        }
      }
    });
  }
});

it('keeps failure-path Actions behind successful trust preparation', () => {
  const directory = resolve(import.meta.dirname, '../../../.github/workflows');
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name))) {
    const workflow = readFileSync(resolve(directory, file), 'utf8');
    for (const job of (workflow.split('\njobs:\n')[1] ?? '').split(/(?=^  [\w-]+:\n)/mu)) {
      const steps = job.split('    steps:\n')[1] ?? '';
      const first = steps.split('\n      - ')[0] ?? '';
      for (const step of steps.split(/(?=^      - )/mu)) {
        if (!/^      - uses:|^        uses:/mu.test(step)) continue;
        const condition = step.match(/^        if: (.*)$/mu)?.[1] ?? '';
        if (!/\b(?:always|failure|cancelled)\(/u.test(condition)) continue;
        expect(first, `${file}: primer identity`).toContain('id: node_trust');
        expect(condition, `${file}: ${step.split('\n')[0]}`).toMatch(
          /^\$\{\{ steps\.node_trust\.outcome == 'success' && \(/u
        );
      }
    }
  }
});
