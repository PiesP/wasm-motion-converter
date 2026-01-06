export type ValidationSeverity = 'info' | 'warning' | 'error';

export interface ValidationWarning {
  severity: ValidationSeverity;
  message: string;
  details?: string;
  suggestedAction?: string;
  requiresConfirmation: boolean;
}

export interface DurationValidationResult {
  valid: boolean;
  duration: number;
  estimatedFrames?: number;
  warnings: ValidationWarning[];
}

export interface ValidationResult {
  isValid: boolean;
  format?: string;
  codec?: string;
  duration?: number;
  estimatedFrames?: number;
  warnings: ValidationWarning[];
}
