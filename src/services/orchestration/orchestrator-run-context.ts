import { createId } from '@utils/create-id';

export type OrchestratorRunContext = {
  operationId: string;
  isActive: () => boolean;
};

export const createRunContext = (
  getActiveOperationId: () => string | null,
  setActiveOperationId: (id: string | null) => void
): OrchestratorRunContext => {
  const operationId = createId();
  setActiveOperationId(operationId);

  return {
    operationId,
    isActive: () => getActiveOperationId() === operationId,
  };
};
