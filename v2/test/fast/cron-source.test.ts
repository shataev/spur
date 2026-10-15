import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cronInstances: FakeCron[] = [];

const DEFAULT_NEXT_RUNS = (): Date[] => [
  new Date("2026-03-25T10:00:00.000Z"),
  new Date("2026-03-25T10:05:00.000Z"),
  new Date("2026-03-25T10:10:00.000Z"),
];

// nextRuns is mutable so throw-paths can drive < 2 runs or a zero interval.
let fakeCronNextRuns: Date[] = DEFAULT_NEXT_RUNS();

class FakeCron {
  readonly stop = vi.fn();
  readonly callback: () => void;

  constructor(
    readonly schedule: string,
    callback: () => void,
  ) {
    this.callback = callback;
    cronInstances.push(this);
  }

  nextRuns(count: number): Date[] {
    return fakeCronNextRuns.slice(0, count);
  }

  trigger(): void {
    this.callback();
  }
}

vi.mock("croner", () => ({
  Cron: FakeCron,
}));

async function loadCronSourceModule() {
  vi.resetModules();
  cronInstances.splice(0);
  return import("../../src/event-sources/cron.js");
}

describe("cronSourceModule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T10:00:00.000Z"));
    fakeCronNextRuns = DEFAULT_NEXT_RUNS();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cronInstances.splice(0);
  });

  it("suppresses cron ticks that arrive before the schedule's own cadence elapses", async () => {
    const emit = vi.fn();
    const info = vi.fn();
    const { cronSourceModule } = await loadCronSourceModule();
    const handle = await cronSourceModule.start({
      sourceId: "morning",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "cron",
        schedule: "*/5 * * * *",
        runOnStart: true,
      },
      emit,
      signal: new AbortController().signal,
      logger: { info },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    expect(emit).toHaveBeenCalledTimes(1);

    cronInstances[0]?.trigger();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("cron tick suppressed"));

    vi.advanceTimersByTime(5 * 60_000);
    cronInstances[0]?.trigger();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("does not suppress a tick that fires a few milliseconds before a full cadence", async () => {
    // Daily weekday schedule: the tightest gap is exactly 24h, and timer jitter can make
    // the next tick measure as 86_399_999ms after the previous one.
    fakeCronNextRuns = [
      new Date("2026-03-25T07:30:00.000Z"),
      new Date("2026-03-26T07:30:00.000Z"),
      new Date("2026-03-27T07:30:00.000Z"),
    ];
    const emit = vi.fn();
    const info = vi.fn();
    const { cronSourceModule } = await loadCronSourceModule();
    await cronSourceModule.start({
      sourceId: "standup",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "cron", schedule: "30 7 * * 1-5", runOnStart: false },
      emit,
      signal: new AbortController().signal,
      logger: { info },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    cronInstances[0]?.trigger();
    expect(emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(24 * 60 * 60_000 - 1);
    cronInstances[0]?.trigger();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("cron tick suppressed"));
  });

  it("rejects start when the schedule yields fewer than two runs", async () => {
    fakeCronNextRuns = [new Date("2026-03-25T10:00:00.000Z")];
    const { cronSourceModule } = await loadCronSourceModule();

    await expect(
      cronSourceModule.start({
        sourceId: "morning",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "cron", schedule: "*/5 * * * *", runOnStart: true },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      }),
    ).rejects.toThrow(/Unable to derive a minimum interval/);
  });

  it("rejects start when no positive interval can be derived", async () => {
    fakeCronNextRuns = [new Date("2026-03-25T10:00:00.000Z"), new Date("2026-03-25T10:00:00.000Z")];
    const { cronSourceModule } = await loadCronSourceModule();

    await expect(
      cronSourceModule.start({
        sourceId: "morning",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "cron", schedule: "*/5 * * * *", runOnStart: true },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      }),
    ).rejects.toThrow(/Unable to derive a minimum interval/);
  });

  it("stops emitting and stops the cron job after stop()", async () => {
    const emit = vi.fn();
    const { cronSourceModule } = await loadCronSourceModule();
    const handle = await cronSourceModule.start({
      sourceId: "morning",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "cron", schedule: "*/5 * * * *", runOnStart: true },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.stop();
    cronInstances[0]?.trigger();

    expect(emit).not.toHaveBeenCalled();
    expect(cronInstances[0]?.stop).toHaveBeenCalled();
  });

  it("suppresses ticks when the abort signal is already aborted", async () => {
    const emit = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const { cronSourceModule } = await loadCronSourceModule();
    const handle = await cronSourceModule.start({
      sourceId: "morning",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "cron", schedule: "*/5 * * * *", runOnStart: true },
      emit,
      signal: controller.signal,
      logger: { info: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    cronInstances[0]?.trigger();

    expect(emit).not.toHaveBeenCalled();
  });
});
