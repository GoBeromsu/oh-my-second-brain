import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorUsage, runDoctorCommand } from "./doctor-command.js";

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function stderr(): string {
  return error.mock.calls.map(call => String(call[0])).join("\n");
}

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = 0;
});

describe("oms doctor", () => {
  it("prints usage: exit 1 with no leaf, exit 0 for --help", async () => {
    await runDoctorCommand([]);
    expect(process.exitCode).toBe(1);
    expect(String(log.mock.calls[0]?.[0])).toBe(doctorUsage());
    await runDoctorCommand(["--help"]);
    expect(process.exitCode).toBe(0);
  });

  it("rejects an unknown leaf and names the leaves", async () => {
    await runDoctorCommand(["repair"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Unknown doctor leaf: repair");
    expect(stderr()).toContain("sync-embeddings");
  });

  it("validates sync-embeddings modes before any index work", async () => {
    for (const [argv, message] of [
      [[], "--mode <sync|embed|repair> is required"],
      [["--mode"], "--mode requires a value"],
      [["--mode", "--dry-run"], "--mode requires a value"],
      [["--mode", "rebuild"], "unknown mode rebuild"],
      [["--mode", "sync", "--mode", "embed"], "duplicate flag --mode"],
      [["--mode", "sync", "--repair-mode", "fts"], "--repair-mode applies only to --mode repair"],
      [["--mode", "repair", "--repair-mode"], "--repair-mode requires a value"],
    ] as const) {
      error.mockClear();
      await runDoctorCommand(["sync-embeddings", ...argv]);
      expect(process.exitCode, argv.join(" ")).toBe(1);
      expect(stderr(), argv.join(" ")).toContain(`doctor sync-embeddings: ${message}`);
    }
    expect(log).not.toHaveBeenCalled();
  });
});
