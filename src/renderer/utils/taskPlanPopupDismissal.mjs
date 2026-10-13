// Native event identity survives DOM removal and React updates between phases.
const childDismissals = new WeakMap();
export function claimTaskPlanChildDismissal(event, owner) {
  childDismissals.set(event, owner);
}
export function isTaskPlanChildDismissal(event, owner) {
  return childDismissals.get(event) === owner;
}
