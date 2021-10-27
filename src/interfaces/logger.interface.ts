export interface Logger {
  error: (message?: any, ...optionalParams: any[]) => void;
  warn: (message?: any, ...optionalParams: any[]) => void;
}

export interface MainLogger extends Logger {
  log: (message?: any, ...optionalParams: any[]) => void;
}