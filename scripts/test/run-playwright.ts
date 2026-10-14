import { isCliEntry, packageBinary, runChild } from '../check/run-child.ts';

export type PlaywrightProfile = 'ci' | 'resource' | 'deploy';

export function runPlaywright(
  profile: PlaywrightProfile,
  args: string[],
  run: typeof runChild = runChild,
  overrides: NodeJS.ProcessEnv = {}
): Promise<number> {
  // Playwright 1.64 owns a separate webServer group and tears it down on SIGINT.
  // Isolate its CLI from the outer pnpm group so SIGTERM can request that cleanup;
  // runChild still reports the original parent interruption as 143.
  return run(
    packageBinary('@playwright/test', 'playwright'),
    ['test', ...args],
    { PLAYWRIGHT_TEST_PROFILE: profile, ...overrides },
    { signalScope: 'process-group', gracefulTerminationSignal: 'SIGINT' }
  );
}

if (isCliEntry(import.meta.url)) {
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
