import pino, { type Logger } from "pino";

export function createBrokerLogger(level = "info"): Logger {
  return pino({
    level,
    redact: {
      paths: [
        "*.authorization",
        "*.installationSecret",
        "*.sendSecret",
        "*.target",
        "*.targetValue",
        "*.title",
        "*.body",
      ],
      censor: "[redacted]",
    },
  });
}
