import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Signer } from "@4evergent/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  createActivity,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
  InMemoryAgentStore,
  type ExecutionRecord,
} from "@4evergent/database";
import { ExecutionQueue } from "../src/execution-queue.js";

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const TEST_AGENT = {
  id: "agent-369",
  displayName: "Agent 369",
  description: "test agent for issue 369",
  ownerId: "owner-369",
  stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  capabilities: [],
  status: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(
  customQueue?: ExecutionQueue,
  customStores?: {
    executionStore?: InMemoryExecutionStore;
    activityStore?: InMemoryActivityStore;
    approvalStore?: InMemoryApprovalStore;
  }
) {
  const executionStore = customStores?.executionStore ?? new InMemoryExecutionStore();
  const activityStore = customStores?.activityStore ?? new InMemoryActivityStore();
  const approvalStore = customStores?.approvalStore ?? new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("agent-369"),
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    policyRules: {
      maxTxAmount: { XLM: "1000" },
      requireHumanApprovalForAmountAbove: "10",
    },
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-369" }),
    executionQueue: customQueue
      ? { enabled: true, instance: customQueue }
      : { enabled: true, intervalMs: 60_000 },
  });
  server.registerAgent(TEST_AGENT);

  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    close: () => server.close(),
    executionStore,
    activityStore,
    approvalStore,
    server,
  };
}

async function post(baseUrl: string, path: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// =============================================================================
// TEST 1 — Cancellation updates all linked records (Issue #369)
// =============================================================================
test("TEST 1: cancelling a queued approved execution transitions execution, approval, and activity to coherent terminal states", async () => {
  const { baseUrl, close, executionStore, activityStore, approvalStore } = await startServer();
  try {
    // 1. Submit an intent requiring approval (> 10 XLM threshold)
    const intentRes = await post(baseUrl, `/agents/${TEST_AGENT.id}/intents`, {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "issue 369 linked records test",
    });
    assert.equal(intentRes.status, 202);
    const { approvalId, activityId } = intentRes.body;
    assert.ok(approvalId);
    assert.ok(activityId);

    // Initial state before approval:
    // Activity is requires_approval / pending_approval
    const initialActivity = await activityStore.get(activityId);
    assert.equal(initialActivity?.status, "requires_approval");
    assert.equal(initialActivity?.authorizationStatus, "pending_approval");

    // Approval is pending_approval
    const initialApproval = await approvalStore.get(approvalId);
    assert.equal(initialApproval?.status, "pending_approval");

    // 2. Approve the intent — transitions approval to 'approved' and enqueues an execution
    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`);
    assert.equal(approveRes.status, 200);

    // Mid-state (approved & queued):
    const approvedApproval = await approvalStore.get(approvalId);
    assert.equal(approvedApproval?.status, "approved");

    const execs = await executionStore.listByOwner("owner-369");
    assert.equal(execs.length, 1);
    const execution = execs[0];
    assert.equal(execution.status, "queued");
    assert.equal(execution.approvalId, approvalId);
    assert.equal(execution.activityId, activityId);

    // 3. Cancel the queued execution
    const cancelRes = await post(baseUrl, `/executions/${execution.id}/cancel`);
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.execution.status, "cancelled");
    assert.match(cancelRes.body.message, /execution cancelled/i);
    assert.match(cancelRes.body.message, /re-submission required/i);

    // Verify:
    // A. Execution is cancelled
    const updatedExec = await executionStore.get(execution.id);
    assert.equal(updatedExec?.status, "cancelled");
    assert.equal(updatedExec?.error, "cancelled by user");

    // B. Approval is no longer approved — moved to terminal 'failed' with cancellation reason
    const updatedApproval = await approvalStore.get(approvalId);
    assert.notEqual(updatedApproval?.status, "approved");
    assert.equal(updatedApproval?.status, "failed");
    assert.match(updatedApproval?.error ?? "", /execution cancelled by user/i);
    assert.match(updatedApproval?.error ?? "", /re-submission required/i);

    // C. Activity is no longer requires_approval / pending_approval — moved to terminal 'failed'
    const updatedActivity = await activityStore.get(activityId);
    assert.notEqual(updatedActivity?.status, "requires_approval");
    assert.equal(updatedActivity?.status, "failed");
    assert.equal(updatedActivity?.authorizationStatus, "approved"); // Intent WAS approved before execution cancelled
    assert.match(updatedActivity?.error ?? "", /execution cancelled by user/i);
    assert.match(updatedActivity?.error ?? "", /re-submission required/i);

    // D. Approvals page query (GET /approvals?status=pending_approval) does NOT return the cancelled approval
    const pendingApprovalsRes = await get(baseUrl, "/approvals?status=pending_approval");
    assert.equal(pendingApprovalsRes.status, 200);
    const pendingIds = (pendingApprovalsRes.body.approvals as Array<{ id: string }>).map((a) => a.id);
    assert.ok(!pendingIds.includes(approvalId), "cancelled approval must not appear in pending_approval queue");

    // E. Approval detail (GET /approvals/:id) displays terminal status 'failed' and cancellation error
    const approvalDetailRes = await get(baseUrl, `/approvals/${approvalId}`);
    assert.equal(approvalDetailRes.status, 200);
    assert.equal(approvalDetailRes.body.approval.status, "failed");
    assert.match(approvalDetailRes.body.approval.error, /re-submission required/i);

    // F. Activity list and detail queries display terminal status 'failed' and cancellation error
    const activityListRes = await get(baseUrl, "/activity");
    assert.equal(activityListRes.status, 200);
    const listedActivity = (activityListRes.body.activity as Array<{ id: string; status: string }>).find((a) => a.id === activityId);
    assert.ok(listedActivity);
    assert.equal(listedActivity.status, "failed");

    const activityDetailRes = await get(baseUrl, `/agents/${TEST_AGENT.id}/activity/${activityId}`);
    assert.equal(activityDetailRes.status, 200);
    assert.equal(activityDetailRes.body.activity.status, "failed");
    assert.equal(activityDetailRes.body.activity.authorizationStatus, "approved");
    assert.match(activityDetailRes.body.activity.error, /re-submission required/i);
  } finally {
    await close();
  }
});

// =============================================================================
// TEST 2 — Cancelled execution retry behavior & re-submission requirement (Issue #369)
// =============================================================================
test("TEST 2: retrying a cancelled execution is rejected (Option 2 — Re-submission required)", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const intentRes = await post(baseUrl, `/agents/${TEST_AGENT.id}/intents`, {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "test 2 retry rejection",
    });
    const { approvalId, activityId } = intentRes.body;
    await post(baseUrl, `/approvals/${approvalId}/approve`);

    const execs = await executionStore.listByOwner("owner-369");
    const execution = execs[0];

    // Cancel the execution
    const cancelRes = await post(baseUrl, `/executions/${execution.id}/cancel`);
    assert.equal(cancelRes.status, 200);
    // Cancellation response explicitly communicates re-submission requirement
    assert.match(cancelRes.body.message, /re-submission required/i);

    // 1. POST /executions/:id/retry on a cancelled execution returns 409 INVALID_EXECUTION_STATE
    const retryRes = await post(baseUrl, `/executions/${execution.id}/retry`);
    assert.equal(retryRes.status, 409);
    assert.match(retryRes.body.error, /cannot retry execution in status 'cancelled'/i);

    // 2. Approval state machine prevents re-approving a failed approval
    const reApproveRes = await post(baseUrl, `/approvals/${approvalId}/approve`);
    assert.equal(reApproveRes.status, 409);
    assert.match(reApproveRes.body.message, /cannot approve/i);

    // 3. Approval state machine prevents re-rejecting a failed approval
    const reRejectRes = await post(baseUrl, `/approvals/${approvalId}/reject`);
    assert.equal(reRejectRes.status, 409);
    assert.match(reRejectRes.body.message, /cannot reject/i);

    // 4. Operator can cleanly submit a NEW intent, creating a fresh approval & execution lifecycle
    const newIntentRes = await post(baseUrl, `/agents/${TEST_AGENT.id}/intents`, {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "fresh resubmitted intent",
    });
    assert.equal(newIntentRes.status, 202);
    assert.notEqual(newIntentRes.body.approvalId, approvalId);
    assert.notEqual(newIntentRes.body.activityId, activityId);

    // Fresh approval can be approved normally
    const newApproveRes = await post(baseUrl, `/approvals/${newIntentRes.body.approvalId}/approve`);
    assert.equal(newApproveRes.status, 200);
    assert.equal(newApproveRes.body.status, "approved");
  } finally {
    await close();
  }
});

// =============================================================================
// TEST 3 — Existing cancellation behavior preserved
// =============================================================================
test("TEST 3: existing cancellation semantics and edge-case validations remain intact", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    // A. 404 on nonexistent execution
    const notFoundRes = await post(baseUrl, "/executions/nonexistent-id/cancel");
    assert.equal(notFoundRes.status, 404);

    // B. Re-cancelling already cancelled execution returns 409
    const exec: ExecutionRecord = {
      id: "already-cancelled",
      ownerId: "owner-369",
      agentId: TEST_AGENT.id,
      approvalId: null,
      activityId: null,
      intent: { type: "payment", asset: "XLM", destination: "GDEST", amount: "5", reason: "test" },
      status: "cancelled",
      policyDecision: null,
      simulationResult: null,
      txHash: null,
      submittedHash: null,
      error: "cancelled by user",
      attempt: 0,
      nextRetryAt: null,
      startedAt: null,
      completedAt: new Date().toISOString(),
      errorClass: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await executionStore.record(exec);

    const reCancelRes = await post(baseUrl, `/executions/${exec.id}/cancel`);
    assert.equal(reCancelRes.status, 409);
    assert.match(reCancelRes.body.error, /cannot cancel execution in status 'cancelled'/i);

    // C. Non-cancellable submitted/confirmed executions return 409
    const submittedExec: ExecutionRecord = {
      ...exec,
      id: "submitted-exec",
      status: "submitted",
      txHash: "tx-hash-submitted",
    };
    await executionStore.record(submittedExec);
    const cancelSubmittedRes = await post(baseUrl, `/executions/${submittedExec.id}/cancel`);
    assert.equal(cancelSubmittedRes.status, 409);
    assert.match(cancelSubmittedRes.body.error, /cannot cancel execution in status 'submitted'/i);
  } finally {
    await close();
  }
});

// =============================================================================
// TEST 4 — Failure and consistency handling (missing associations, schedule executions)
// =============================================================================
test("TEST 4: cancellation gracefully handles missing associations and schedule-driven executions", async () => {
  const { baseUrl, close, executionStore, activityStore } = await startServer();
  try {
    // Case A: Missing approval record (invalid association) does not break execution cancellation
    const orphanExec: ExecutionRecord = {
      id: "orphan-exec",
      ownerId: "owner-369",
      agentId: TEST_AGENT.id,
      approvalId: "missing-approval-id",
      activityId: null,
      intent: { type: "payment", asset: "XLM", destination: "GDEST", amount: "5", reason: "test" },
      status: "queued",
      policyDecision: null,
      simulationResult: null,
      txHash: null,
      submittedHash: null,
      error: null,
      attempt: 0,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      errorClass: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await executionStore.record(orphanExec);

    const cancelOrphanRes = await post(baseUrl, `/executions/${orphanExec.id}/cancel`);
    assert.equal(cancelOrphanRes.status, 200);
    assert.equal(cancelOrphanRes.body.execution.status, "cancelled");

    // Case B: Schedule-driven execution (activityId present, approvalId null)
    const act = createActivity(TEST_AGENT.id, "owner-369", {
      type: "payment",
      asset: "XLM",
      destination: "GDEST",
      amount: "5",
      reason: "scheduled execution",
    }, {
      result: "allow",
      reason: "within limits",
      rule: "maxAmount",
      intent: { type: "payment", asset: "XLM", destination: "GDEST", amount: "5", reason: "scheduled execution" },
    });
    await activityStore.record(act);

    const schedExec: ExecutionRecord = {
      id: "schedule-exec",
      ownerId: "owner-369",
      agentId: TEST_AGENT.id,
      approvalId: null,
      activityId: act.id,
      intent: act.intent,
      status: "queued",
      policyDecision: null,
      simulationResult: null,
      txHash: null,
      submittedHash: null,
      error: null,
      attempt: 0,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      errorClass: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await executionStore.record(schedExec);

    const cancelSchedRes = await post(baseUrl, `/executions/${schedExec.id}/cancel`);
    assert.equal(cancelSchedRes.status, 200);

    const updatedSchedAct = await activityStore.get(act.id);
    assert.equal(updatedSchedAct?.status, "failed");
    assert.equal(updatedSchedAct?.authorizationStatus, null); // Unchanged since it was not an approval
    assert.match(updatedSchedAct?.error ?? "", /execution cancelled by user/i);
  } finally {
    await close();
  }
});

// =============================================================================
// TEST 5 — In-flight execution cancellation updates linked records
// =============================================================================
test("TEST 5: in-flight executing cancellation updates linked approval and activity", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  let resolveRunning: () => void;
  const runningPromise = new Promise<void>((r) => {
    resolveRunning = r;
  });

  const customQueue = new ExecutionQueue(
    executionStore,
    async (rec, ctx) => {
      resolveRunning();
      await new Promise((r) => setTimeout(r, 60));

      if (ctx?.signal.aborted) {
        const err = new Error("Execution was cancelled");
        err.name = "AbortError";
        throw err;
      }
      return { record: rec, success: true, status: "submitted", txHash: "tx-999" };
    },
    async () => ({ accountId: () => "GDEST", sequenceNumber: () => "1", incrementSequenceNumber: () => {} }),
    { approvalStore, activityStore }
  );

  const { baseUrl, close } = await startServer(customQueue, { executionStore, activityStore, approvalStore });
  try {
    const intentRes = await post(baseUrl, `/agents/${TEST_AGENT.id}/intents`, {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "in-flight cancellation test",
    });
    const { approvalId, activityId } = intentRes.body;
    await post(baseUrl, `/approvals/${approvalId}/approve`);

    const execs = await executionStore.listByOwner("owner-369");
    const execution = execs[0];
    await executionStore.update(execution.id, { nextRetryAt: "2026-01-01T00:00:00Z" });

    const processPromise = customQueue.processDue("2026-01-01T00:00:01Z");
    await runningPromise;

    // Issue cancel while pipeline is running
    const cancelRes = await post(baseUrl, `/executions/${execution.id}/cancel`);
    assert.equal(cancelRes.status, 200);

    await processPromise;

    // Verify all 3 records reached terminal state
    const finalExec = await executionStore.get(execution.id);
    assert.equal(finalExec?.status, "cancelled");

    const finalApproval = await approvalStore.get(approvalId);
    assert.equal(finalApproval?.status, "failed");
    assert.match(finalApproval?.error ?? "", /execution cancelled by user/i);

    const finalActivity = await activityStore.get(activityId);
    assert.equal(finalActivity?.status, "failed");
    assert.equal(finalActivity?.authorizationStatus, "approved");
    assert.match(finalActivity?.error ?? "", /execution cancelled by user/i);
  } finally {
    await close();
  }
});
