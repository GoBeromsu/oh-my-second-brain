export interface ParsedCliArgs {
  readonly command: string | undefined;
  readonly help: boolean;
  /** Arguments after the command, left raw for the family handler (help flags excluded). */
  readonly unknownFlags: readonly string[];
}

/**
 * Every public family, setup included, owns its argv contract. The top-level
 * parser only recognizes the command and the common help route.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const firstArg = argv[0];
  const command = firstArg === "--help" || firstArg === "-h" ? undefined : firstArg;
  const help =
    firstArg === "--help"
    || firstArg === "-h"
    || argv.slice(1).some((arg) => arg === "--help" || arg === "-h");
  return {
    command,
    help,
    unknownFlags: argv.slice(1).filter((arg) => arg !== "--help" && arg !== "-h"),
  };
}
