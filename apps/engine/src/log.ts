export type LogData = Record<string, unknown>;

export interface Logger {
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

/** JSON-lines logger on stdout. Callers must never pass secrets in `data`. */
export function consoleLogger(): Logger {
  const write = (level: string) => (msg: string, data?: LogData) => {
    console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...data }));
  };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}
