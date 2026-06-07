export function createServiceGraph() {
  return {
    services: [
      {
        id: "gateway",
        dependsOn: ["auth", "orders", "pricing"],
      },
      {
        id: "auth",
        dependsOn: [],
      },
      {
        id: "orders",
        dependsOn: ["pricing", "ledger", "notifications"],
      },
      {
        id: "pricing",
        dependsOn: [],
      },
      {
        id: "ledger",
        dependsOn: [],
      },
      {
        id: "notifications",
        dependsOn: [],
      },
      {
        id: "ops-console",
        dependsOn: ["gateway"],
      }
    ]
  };
}

export function getDownstreamServices(graph, targetId) {
  const downstream = [];

  for (const service of graph.services) {
    if (service.dependsOn.includes(targetId)) {
      downstream.push(service.id);
    }
  }

  return downstream;
}
