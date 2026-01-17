import { createId } from '@utils/create-id';

export type OrchestratorRunContext = {
  operationId: string;
  isActive: () => boolean;
};

type ActiveOperationIdGetter = () => string | null;

type ActiveOperationIdSetter = (id: string | null) => void;

export function createRunContext(
  getActiveOperationId: ActiveOperationIdGetter,
  setActiveOperationId: ActiveOperationIdSetter
): OrchestratorRunContext {
  const operationId = createId();
  setActiveOperationId(operationId);

  return {
    operationId,
    isActive: () => getActiveOperationId() === operationId,
  };
}
