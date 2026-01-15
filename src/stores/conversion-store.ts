/**
 * Conversion Store
 *
 * Central export surface for conversion-related state stores.
 * Prefer importing specific stores directly when possible.
 */

export {
  errorContext,
  errorMessage,
  setErrorContext,
  setErrorMessage,
} from '@stores/conversion-error-store';

export {
  inputFile,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-media-store';

export {
  setAutoAppliedRecommendation,
  setPerformanceWarnings,
} from '@stores/conversion-performance-store';

export {
  conversionProgress,
  conversionStatusMessage,
  setConversionProgress,
  setConversionStatusMessage,
} from '@stores/conversion-progress-store';

export {
  conversionResults,
  MAX_RESULTS,
  setConversionResults,
} from '@stores/conversion-result-store';

export {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  saveConversionSettings,
  setConversionSettings,
} from '@stores/conversion-settings-store';
