import 'winston';

declare module 'winston' {
  interface Logger {
    success: LeveledLogMethod;
    debug: LeveledLogMethod;
  }
}
