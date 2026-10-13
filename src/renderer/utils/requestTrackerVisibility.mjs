export function isRequestSuccessPresentation(presentation) {
  // Display only: hiding a delivered chip does not settle its runtime or handoff.
  return presentation.icon === 'success' || presentation.icon === 'delivered'
    || presentation.color === '#4ade80';
}
