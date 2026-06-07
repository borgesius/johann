import { createServiceGraph } from "../domain/service-graph.js";

export function createSimulatedFleet() {
  return {
    graph: createServiceGraph(),
    environments: [
      {
        id: "staging",
        queueDepth: 1,
      },
      {
        id: "production",
        queueDepth: 2,
      }
    ],
    pendingReleases: [
      {
        id: "rel-pricing-042",
        serviceId: "pricing",
        targetEnvironment: "staging",
        requestedBy: "ops.lead",
      }
    ]
  };
}
