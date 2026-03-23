import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeMessage,
  parseBridgeMessageJson,
} from "../lib/federation/bridge-protocol.js";

test("parseBridgeMessage parses a cluster-agent hello with advertised topology", () => {
  const message = parseBridgeMessage({
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    sentAt: "2026-03-23T05:00:00.000Z",
    traceId: "trace-hello-1",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    clusterId: "local-dev",
    agentId: "cluster-agent-1",
    peerDid: "did:web:local.promethean.rest",
    environment: "local",
    bridgeAgentVersion: "0.1.0",
    authMode: "at_did",
    capabilitiesHash: "abc123",
    labels: ["laptop", "oauth-enclave"],
    topology: {
      groups: [
        { groupId: "group-a", nodeIds: ["a1", "a2"] },
        { groupId: "group-b", nodeIds: ["b1", "b2"] },
      ],
      nodes: [
        { groupId: "group-a", nodeId: "a1", labels: ["default"] },
        { groupId: "group-a", nodeId: "a2", labels: ["spillover"] },
      ],
      defaultExecutionPolicy: "group_affinity",
    },
  });

  assert.equal(message.type, "hello");
  assert.equal(message.agentId, "cluster-agent-1");
  assert.equal(message.topology?.groups.length, 2);
  assert.equal(message.topology?.nodes[0]?.nodeId, "a1");
  assert.equal(message.topology?.defaultExecutionPolicy, "group_affinity");
});

test("parseBridgeMessage parses capabilities with topology targets", () => {
  const message = parseBridgeMessage({
    type: "capabilities",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    sessionId: "session-1",
    sentAt: "2026-03-23T05:00:01.000Z",
    traceId: "trace-cap-1",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    clusterId: "local-dev",
    agentId: "cluster-agent-1",
    capabilities: [
      {
        providerId: "openai",
        modelPrefixes: ["gpt-"],
        models: ["gpt-5.2", "gpt-5.2-codex"],
        authType: "oauth_bearer",
        accountCount: 12,
        availableAccountCount: 9,
        supportsModelsList: true,
        supportsChatCompletions: true,
        supportsResponses: true,
        supportsStreaming: true,
        supportsWarmImport: false,
        credentialMobility: "non_exportable",
        credentialOrigin: "localhost_oauth",
        lastHealthyAt: "2026-03-23T04:59:59.000Z",
        topologyTargets: [
          { groupId: "group-a", nodeId: "a1" },
          { groupId: "group-a", nodeId: "a2" },
        ],
      },
    ],
  });

  assert.equal(message.type, "capabilities");
  assert.equal(message.capabilities.length, 1);
  assert.equal(message.capabilities[0]?.providerId, "openai");
  assert.deepEqual(message.capabilities[0]?.topologyTargets, [
    { groupId: "group-a", nodeId: "a1" },
    { groupId: "group-a", nodeId: "a2" },
  ]);
});

test("parseBridgeMessageJson parses response_head messages", () => {
  const message = parseBridgeMessageJson(JSON.stringify({
    type: "response_head",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    sessionId: "session-1",
    streamId: "stream-1",
    sentAt: "2026-03-23T05:00:02.000Z",
    traceId: "trace-resp-1",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    clusterId: "staging",
    agentId: "cluster-agent-1",
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-open-hax-upstream-provider": "openai",
    },
    servedByClusterId: "local-dev",
    servedByGroupId: "group-a",
    servedByNodeId: "a1",
    providerId: "openai",
    accountId: "acct-1",
  }));

  assert.equal(message.type, "response_head");
  assert.equal(message.status, 200);
  assert.equal(message.servedByNodeId, "a1");
  assert.equal(message.headers["content-type"], "application/json");
});

test("parseBridgeMessage rejects hello frames that still try to identify the socket as a node", () => {
  assert.throws(() => parseBridgeMessage({
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    sentAt: "2026-03-23T05:00:00.000Z",
    traceId: "trace-hello-2",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    clusterId: "local-dev",
    peerDid: "did:web:local.promethean.rest",
    groupId: "group-a",
    nodeId: "a1",
    environment: "local",
    bridgeAgentVersion: "0.1.0",
    authMode: "admin_key",
  }), /agentId/);
});

test("parseBridgeMessage rejects unsupported protocol versions", () => {
  assert.throws(() => parseBridgeMessage({
    type: "heartbeat",
    protocolVersion: "bridge-ws-v1",
    sentAt: "2026-03-23T05:00:03.000Z",
    traceId: "trace-heartbeat-1",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    clusterId: "local-dev",
    agentId: "cluster-agent-1",
    sequence: 1,
  }), /protocolVersion/);
});
