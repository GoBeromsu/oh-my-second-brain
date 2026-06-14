import { describe, expect, it } from "vitest";
import { maybePrintUpdateNotice } from "./oms.js";
import type { UpdateRunnerCall } from "../update/update.js";

function okCall(stdout = ""): UpdateRunnerCall {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("CLI update notice", () => {
  it("prints an update notice through the injected writer", async () => {
    const messages: string[] = [];

    await maybePrintUpdateNotice({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      write: (message) => messages.push(message),
      runner: () => okCall(),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Update available: 0.1.7 -> 0.1.8");
    expect(messages[0]).toContain("oms update --yes");
  });

  it("does not query or print when update notices are disabled", async () => {
    const calls: string[] = [];
    const messages: string[] = [];

    await maybePrintUpdateNotice({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      env: { OMS_UPDATE_NOTICE: "0" },
      write: (message) => messages.push(message),
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall("0.1.8");
      },
    });

    expect(calls).toEqual([]);
    expect(messages).toEqual([]);
  });
});
