export type AppState =
  | 'idle'
  | 'loading-ffmpeg'
  | 'analyzing'
  | 'warning'
  | 'converting'
  | 'done'
  | 'error';
