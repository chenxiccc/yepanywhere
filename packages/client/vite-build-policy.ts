import { createLogger } from "vite";

export function warningFreeBuildLogger(label: string) {
  const logger = createLogger();
  const fail = (message: string): never => {
    throw new Error(`${label} build warning: ${message}`);
  };
  logger.warn = fail;
  logger.warnOnce = fail;
  return logger;
}
