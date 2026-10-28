export type LogLevel = "INFO" | "WARN" | "ERROR";

export const log = (level: LogLevel, ...args: unknown[]): void => {
  console.log(new Date().toISOString(), level, ...args);
};
