/** Print a styled status line to stderr (human-friendly output). */
export function status(label: string, message: string): void {
  process.stderr.write(`  ${label.padEnd(20)} ${message}\n`);
}

/** Print a blank line to stderr. */
export function blank(): void {
  process.stderr.write("\n");
}
