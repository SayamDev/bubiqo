/**
 * Execution and verification — including Complete It.
 *
 * The invariants, which the tests in tests/executor.test.ts hold to:
 *
 *   - Every execution passes through decide() first. There is no privileged caller.
 *   - A `blocked` Action never executes, by any route, including batched ones.
 *   - A `confirm` Action never executes without an explicit approval for that step.
 *   - Nothing is reported as done until verify() has confirmed it. When verification
 *     cannot confirm, the user is told exactly that rather than shown a tick.
 */

import type { ActionDefinition, ActionInput, Risk, Settings, Suggestion } from "./types";
import type { Ports } from "./ports";
import { decide } from "./safety";

export interface StepOutcome {
  readonly actionId: string;
  readonly name: string;
  readonly risk: Risk;
  /** What actually happened, in the user's language. */
  readonly message: string;
  readonly status: "done" | "unconfirmed" | "failed" | "skipped" | "needs_approval" | "refused";
  readonly undoHandle?: string;
  readonly undoable: boolean;
}

export interface CompleteItReport {
  readonly steps: readonly StepOutcome[];
  readonly done: number;
  readonly needsApproval: number;
  readonly failed: number;
}

export interface ExecuteOptions {
  /** Action ids the user has explicitly approved for this run. */
  readonly approved?: readonly string[];
  /** Hard cap on steps, so no caller can turn this into a loop. */
  readonly maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 8;

export class Executor {
  constructor(
    private readonly registry: ReadonlyMap<string, ActionDefinition>,
    private readonly ports: Ports,
    private readonly settings: Settings,
  ) {}

  /**
   * Run one Action, end to end: permission, execute, verify, record.
   *
   * Returns an outcome rather than throwing for expected refusals, because a refusal
   * is information the user should see, not an exception to swallow.
   */
  async run(actionId: string, input: ActionInput, options: ExecuteOptions = {}): Promise<StepOutcome> {
    const action = this.registry.get(actionId);
    const verdict = decide(action, actionId, this.settings, input.page.domain);

    if (!action || !verdict.allowed) {
      await this.ports.activity.record({ kind: "blocked", summary: verdict.reason, actionId });
      return {
        actionId,
        name: action?.name ?? actionId,
        risk: action?.risk ?? "blocked",
        message: verdict.reason,
        status: "refused",
        undoable: false,
      };
    }

    if (verdict.requiresApproval && !options.approved?.includes(actionId)) {
      return {
        actionId,
        name: action.name,
        risk: action.risk,
        message: verdict.reason,
        status: "needs_approval",
        undoable: false,
      };
    }

    if (verdict.requiresApproval) {
      await this.ports.activity.record({ kind: "approved", summary: `You approved ${action.name}.`, actionId });
    }

    let result;
    try {
      result = await action.execute(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await this.ports.activity.record({ kind: "failed", summary: `${action.name} failed: ${message}`, actionId });
      return { actionId, name: action.name, risk: action.risk, message, status: "failed", undoable: false };
    }

    if (!result.ok) {
      await this.ports.activity.record({ kind: "failed", summary: `${action.name}: ${result.message}`, actionId });
      return { actionId, name: action.name, risk: action.risk, message: result.message, status: "failed", undoable: false };
    }

    await this.ports.activity.record({ kind: "executed", summary: `${action.name}: ${result.message}`, actionId });

    /*
     * Verification decides what the user is told. An action that ran but cannot be
     * confirmed reports "unconfirmed", never "done" — see CONTEXT.md, Verification.
     */
    const verification = await action.verify(result);
    await this.ports.activity.record({
      kind: verification.outcome === "confirmed" ? "verified" : "failed",
      summary: verification.message,
      actionId,
    });

    const base = {
      actionId,
      name: action.name,
      risk: action.risk,
      undoable: result.undoable && action.canUndo,
    };

    if (verification.outcome === "confirmed") {
      return result.handle === undefined
        ? { ...base, message: result.message, status: "done" }
        : { ...base, message: result.message, status: "done", undoHandle: result.handle };
    }

    return result.handle === undefined
      ? { ...base, message: verification.message, status: "unconfirmed" }
      : { ...base, message: verification.message, status: "unconfirmed", undoHandle: result.handle };
  }

  /**
   * Complete It: run the safe Suggestions in order, verify each, report honestly.
   *
   * Confirm-risk steps are surfaced as `needs_approval` rather than executed, so one
   * click can never send, submit or post anything.
   */
  async completeIt(
    suggestions: readonly Suggestion[],
    input: ActionInput,
    options: ExecuteOptions = {},
  ): Promise<CompleteItReport> {
    const limit = Math.min(options.maxSteps ?? DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS);
    const steps: StepOutcome[] = [];

    for (const suggestion of suggestions.slice(0, limit)) {
      const stepInput: ActionInput = { ...input, params: { ...input.params, ...suggestion.params } };
      steps.push(await this.run(suggestion.actionId, stepInput, options));
    }

    return {
      steps,
      done: steps.filter((s) => s.status === "done").length,
      needsApproval: steps.filter((s) => s.status === "needs_approval").length,
      failed: steps.filter((s) => s.status === "failed" || s.status === "refused").length,
    };
  }

  /** Reverse a completed step, where the Action supports it. */
  async undo(actionId: string, handle: string): Promise<StepOutcome> {
    const action = this.registry.get(actionId);
    if (!action?.undo) {
      return {
        actionId,
        name: action?.name ?? actionId,
        risk: action?.risk ?? "safe",
        message: "This action cannot be automatically reversed.",
        status: "refused",
        undoable: false,
      };
    }

    const result = await action.undo({ ok: true, message: "", handle, undoable: true });
    await this.ports.activity.record({ kind: "undone", summary: `${action.name} undone.`, actionId });
    return {
      actionId,
      name: action.name,
      risk: action.risk,
      message: result.message,
      status: result.ok ? "done" : "failed",
      undoable: false,
    };
  }
}
