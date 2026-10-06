import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageBinary, runChild } from '../check/run-child.ts';

export type PlaywrightProfile = 'ci' | 'resource' | 'deploy';

export function runPlaywright(
  profile: PlaywrightProfile,
  args: string[],
  run: typeof runChild = runChild
): Promise<number> {
  return run(packageBinary('@playwright/test', 'playwright'), ['test', ...args], {
    PLAYWRIGHT_TEST_PROFILE: profile,
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.argv[2];
  if (!['ci', 'resource', 'deploy'].includes(profile ?? '')) {
    console.error('Expected ci, resource, or deploy');
    process.exitCode = 1;
  } else {
    runPlaywright(profile as PlaywrightProfile, process.argv.slice(3)).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      }
    );
  }
}
