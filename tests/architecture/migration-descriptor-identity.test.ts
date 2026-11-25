import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATIONS,
  P39_MAINTENANCE_MIGRATION_MANIFEST,
  P39_MAINTENANCE_MIGRATIONS,
} from "../../adapters/persistence-sqlite/src/migrations.js";

// Exact SQL bytes of the formerly inline descriptors at ac71fef, before
// the migration module split. These are historical identities, not snapshots
// to refresh when formatting or moving code. Future versions may be appended.
const historicalPins = [
  [
    1,
    "init",
    "1cf418cbbea2803535cb5bc45e2bd0a5eb1b27821dd08816c89826b799b2a60e",
  ],
  [
    2,
    "execution_session_kernel",
    "8afd25a41b89db32e3729941ad485eb4dc519dead8073a4680a77d76aab15897",
  ],
  [
    3,
    "provider_model_context",
    "44f079e16c77f8bf7f9a8bbb6e94f4de6a98b0e5bbcdc5ff7528dd620e1926ce",
  ],
  [
    4,
    "tool_runtime",
    "09258045cb975e043bad13a94cd7b60186f184d3edff4bd2917f821dcc2f3e4e",
  ],
  [
    5,
    "p6_formation_communication",
    "7b543fdda64185ad5d2565a6e696ab692fd13d3f5093e9db6fd3e6543b079cc5",
  ],
  [
    6,
    "p7_dependency_deliverable",
    "a1c25221f51522d093ff373ef7a620411fb32e3f529c7d296c69741589aa6d70",
  ],
  [
    7,
    "p7_messages_deliver_kind",
    "ac33e44e5b85e1f7333fc8656c45b9f9ff57107ae70ed8b6aff92f282dd374bb",
  ],
  [
    8,
    "p8_verification",
    "aca1de90ef50311d333b1950f91cda7f475bde3701a7394c830393defe81b459",
  ],
  [
    9,
    "p11_environment_changes",
    "e98bb443debb349d0b9c989d42d0ce64d995954309e8edf2aba79122ef943e22",
  ],
  [
    10,
    "p11_worktrees",
    "853ca97bcaaa09797b4a63e4c9d45f65435270199eb6fa19ea9bfb20cd0ce8ed",
  ],
  [
    11,
    "lease_worker_incarnation",
    "a73d412de05c6b41899336447779223c8044eaf6a4b31f28d29bdd4085ec658c",
  ],
  [
    12,
    "permission_grants",
    "dd8b5e596fe019161707d4fec326b14f40459c38667a578864b4d8b2c74eb633",
  ],
  [
    13,
    "project_tool_registry",
    "23743dd461740098ac8ff9f6b36072fa5c0b24acb5eb553777b714c83b6b7287",
  ],
  [
    14,
    "human_messages",
    "c8be60050cbe4d103ac58fce2c6f8ac3951dd5b4f440a5d9fe9f2155f292d792",
  ],
  [
    15,
    "provider_runtime_correctness",
    "4efc3de7a6e91b2b321f19637838e310a381ddbd3ebd4fa1bee949c7fc284e38",
  ],
  [
    16,
    "p16_reasoning_attachment",
    "549b9d035de2715d7673d5895b4c4b20704c4a09972353b88543c478122412cc",
  ],
  [
    17,
    "agent_loop_step_handoff",
    "94a0dda0d7ef6ddd75e4969802c99374653a3f72d5bfd15e61b31a59160a9783",
  ],
  [
    18,
    "project_archive_human_message_terminal",
    "cfae1b7030e9f3a46be39a0b79b43f505ebe8cd314b11df4afdfb9ca8b0cd6c3",
  ],
  [
    19,
    "session_context_runtime_convergence",
    "3fb006251acc2b5294775cf5642ffd514549aeba0eee942f6f0e91a9de436cb3",
  ],
  [
    20,
    "agent_loop_step_provider_turn_chain",
    "e01508f3b43a92bf9438ad24100c65605dbed00a50ae89976e7c95427d40c0e8",
  ],
  [
    21,
    "conversation_delivery_runtime",
    "4da72dd7e3cef8ccbbd3c297b152f70bcff1f2d54b1575edb872738ed12a5880",
  ],
  [
    22,
    "verification_delivery_convergence",
    "0e2f1df1cc4c7f21db04cce6c6067a362ad3538f4a7bd5df79655cf9a5e69369",
  ],
  [
    23,
    "verification_evidence_identity",
    "c9458ac9212ec3272d5a2fe472b2f1089d5017b9888c9b8c4b6e58d04e226731",
  ],
  [
    24,
    "execution_episode_binding",
    "75b940fac69df36747a26729b422ab13a9c294a337ff72cc8fae5de2f44d3d88",
  ],
  [
    25,
    "execution_episode_only",
    "2371f62d1dffce309116951613c9e8b5a8a26603a25c78f436e2909283c91892",
  ],
  [
    26,
    "agent_state_episode_only",
    "358a09961b809d3e74f43c54eefa596130c54c8d0d9c287d6a517743c157c084",
  ],
  [
    27,
    "formation_governance_inbox_backfill",
    "55134e00558e42efeb205093dc34a88c8857c5642c8fec05b343d41a3fd80ad5",
  ],
  [
    28,
    "settled_governance_inbox_cleanup",
    "1aec5f94fe0160de27e9b7d8ecab2597745c3294ebc148deaa8220479cbc05ad",
  ],
  [
    29,
    "subject_bound_permission_grants",
    "c1805dfdee9c685d70cce51e1a1ff83ca83a97e9b1204034207b08063521c1d9",
  ],
  [
    30,
    "control_action_approvals",
    "4efd4e8dfc44b7af8bf3e73c7b97d6b678b1c07679018966a71608c16dc80e74",
  ],
  [
    31,
    "formation_fulfillment",
    "389b3cce832b76b07be23cf29fd01f8ee1c5be5e517e3e44bff83f5a72362f19",
  ],
  [
    32,
    "action_approval_convergence",
    "7b387b835f28e69f6e42cbeaa5afaf2a89904b7c390af60ca3190e1acc900d11",
  ],
  [
    33,
    "assign_work_target_bindings",
    "fd868a362816686a44c9a2a077e43ee72f7a71df5f517f0b279022a046c781e4",
  ],
  [
    34,
    "p10_attention_projection",
    "6e7297077a64d0d5a401e6a62130677db2547d21460d9865ae7a89ef498eeb3e",
  ],
  [
    35,
    "workspace_resource_activation_intents",
    "4380e9fb7aeff6b4c3a3bbf3a67c233cbd20ecaa93599b8d5dd397bfbf38b1e7",
  ],
  [
    36,
    "ah7_tool_invocation_admission",
    "ae6d6f0313061f86156b55c5d3f870817c6a1ee7c101a981f3ddcbcdc8f6eeb5",
  ],
  [
    37,
    "ah10_deliver_replay_attention_rows",
    "0d23988891b3a19a36b6a836a9697d674667681dde2123be4dcae6659e39e737",
  ],
  [
    40,
    "tool_observation_replay_evidence",
    "3b06ee795277152a3e09a97679c4017b5c7ad3d1009f8cd14b04329a2be002aa",
  ],
  [
    41,
    "p41_submitted_decision_binding_attention",
    "d3ad9133ea28150a271c9867ae390c1f6ba0692f9e6b449817b8aeae2aa1dfed",
  ],
  [
    44,
    "approval_rejected_no_effect_denial",
    "2378c0170aae7beb0592c69bfffef9e611da6d5323caaa0de5b7d5360b7ff33f",
  ],
  [
    54,
    "native_process_mode_no_effect_denial",
    "161e6b70c9940a80387eb41dd8fa14d5c0dc5834bc220097681d1f6df60f5597",
  ],
  [
    55,
    "session_causal_provenance",
    "589030dc55c5e6fef68e8bdc5d239894494a1800ee0f5178235501092dd52a1a",
  ],
  [
    56,
    "linux_workspace_network_v2_compatibility_boundary",
    "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a",
  ],
] as const;

const sqlDigest = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

const requiredPredecessors = new Map<number, number>([
  [40, 39],
  [41, 40],
  [44, 43],
  [54, 53],
  [55, 54],
  [56, 55],
]);

describe("historical migration descriptor identity", () => {
  it.each(historicalPins)("preserves migration %i (%s)", (id, name, digest) => {
    const descriptor = CURRENT_MIGRATIONS.find((item) => item.id === id);
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error(`Missing migration ${id}`);
    expect(descriptor.name).toBe(name);
    expect(sqlDigest(descriptor.sql)).toBe(digest);
    expect(descriptor.foreignKeysOff ?? false).toBe(id === 25 || id === 36);
    expect(descriptor.requiresUserVersion).toBe(requiredPredecessors.get(id));
    expect(descriptor.offlineOnly ?? false).toBe(false);
    expect(descriptor.onApply).toBeUndefined();
  });

  it("preserves the ordinary historical registry and maintenance-only P39", () => {
    expect(
      CURRENT_MIGRATIONS.filter((item) => item.id <= 57).map((item) => item.id),
    ).toEqual(
      Array.from({ length: 57 }, (_, index) => index + 1).filter(
        (id) => id !== 39,
      ),
    );
    expect(P39_MAINTENANCE_MIGRATIONS.map((item) => item.id)).toEqual([
      37, 38, 39,
    ]);
    for (const descriptor of P39_MAINTENANCE_MIGRATIONS) {
      const pin = P39_MAINTENANCE_MIGRATION_MANIFEST[descriptor.id];
      expect(pin).toBeDefined();
      expect(descriptor.name).toBe(pin?.name);
      expect(sqlDigest(descriptor.sql)).toBe(pin?.sha256);
    }
  });
});
