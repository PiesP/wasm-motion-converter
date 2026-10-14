import { expect, it, vi } from 'vitest';
import { reloadWhenSafe } from '@/reload-protection';

it('re-reads busy and retained-result state at activation', () => {
  let busy = true;
  let hasResults = false;
  const navigate = vi.fn();
  const activate = () =>
    reloadWhenSafe(
      () => busy,
      () => hasResults,
      navigate
    );

  activate(); // analyzing, converting, or cancelling
  expect(navigate).not.toHaveBeenCalled();
  busy = false;
  hasResults = true;
  activate();
  expect(navigate).not.toHaveBeenCalled();
  hasResults = false;
  activate();
  expect(navigate).toHaveBeenCalledOnce();
});
