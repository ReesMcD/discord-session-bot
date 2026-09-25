/** Loads .env from the working directory if present (Node's built-in loader). */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file; rely on the real environment
  }
}
