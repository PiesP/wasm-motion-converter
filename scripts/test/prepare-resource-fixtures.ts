import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runChild } from '../check/run-child.ts';

export function prepareResourceFixtures(run: typeof runChild = runChild): Promise<number> {
  return run(fileURLToPath(new URL('./generate-e2e-video.ts', import.meta.url)), [], {
    PREPARE_RESOURCE_FIXTURES: 'true',
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareResourceFixtures().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
