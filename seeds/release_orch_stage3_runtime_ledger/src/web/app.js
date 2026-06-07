async function loadFleet() {
  const response = await fetch("/api/fleet");
  if (!response.ok) {
    throw new Error("Failed to load simulated fleet.");
  }
  return response.json();
}

function renderGraph(graph) {
  const root = document.querySelector("#service-graph");
  if (!root) {
    return;
  }
  root.innerHTML = graph.services
    .map((service) => {
      const deps = service.dependsOn.length > 0 ? service.dependsOn.join(", ") : "none";
      return `<li><strong>${service.id}</strong><span> depends on ${deps}</span></li>`;
    })
    .join("");
}

function renderPolicy(policy) {
  const root = document.querySelector("#promotion-rules");
  if (!root) {
    return;
  }
  root.innerHTML = Object.entries(policy.environments)
    .map(([environment, rules]) => {
      const checks = rules.checks.join(", ");
      return `<article><h3>${environment}</h3><p>checks: ${checks}</p><p>approvals: ${rules.approvalsRequired}</p></article>`;
    })
    .join("");
}

function renderQueue(fleet) {
  const root = document.querySelector("#release-queue");
  if (!root) {
    return;
  }
  root.innerHTML = fleet.pendingReleases
    .map((release) => {
      return `<article><h3>${release.id}</h3><p>${release.serviceId} -> ${release.targetEnvironment}</p><p>requested by ${release.requestedBy}</p></article>`;
    })
    .join("");
}

loadFleet()
  .then((payload) => {
    renderGraph(payload.graph);
    renderPolicy(payload.policy);
    renderQueue(payload.fleet);
  })
  .catch((error) => {
    const root = document.querySelector("#release-queue");
    if (root) {
      root.textContent = error instanceof Error ? error.message : String(error);
    }
  });
