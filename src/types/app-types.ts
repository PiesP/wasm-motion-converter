export type AppState =
  | 'idle'
  | 'loading-ffmpeg'
  | 'analyzing'
  | 'converting'
  | 'done'
  | 'error';
