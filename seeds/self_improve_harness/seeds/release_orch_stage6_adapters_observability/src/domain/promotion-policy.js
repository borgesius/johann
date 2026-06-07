export function createDefaultPromotionPolicy() {
  return {
    environments: {
      staging: {
        approvalsRequired: 0,
        checks: ["service-tests", "downstream-tests"],
      },
      production: {
        approvalsRequired: 1,
        checks: ["service-tests", "downstream-tests", "post-deploy-verification"],
        rollbackOnFailure: true,
      }
    }
  };
}
