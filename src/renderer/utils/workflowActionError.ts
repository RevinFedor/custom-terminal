import {useUIStore} from '../store/useUIStore';

type Context = {workflowId?:string;workflowName?:string;action:string;[key:string]:unknown};

/** Formatting adapter for the existing Toast/Copy owner, not another error store. */
export function reportWorkflowActionError(reason:unknown, context:Context) {
  const error=reason as any;
  const message=error?.message || error?.error || String(reason);
  const details=[`Time UTC: ${new Date().toISOString()}`,
    `Workflow: ${context.workflowName || context.workflowId || 'unknown'}`,
    `Workflow ID: ${context.workflowId || 'unknown'}`,`Action: ${context.action}`,
    `Error: ${message}`,
    `Operation: ${JSON.stringify({...context,...error?.workflowOperation},null,2)}`,
    ...(error?.disposition?[`Outcome: ${error.disposition}`]:[]),
    ...(error?.stack?[`Stack: ${error.stack}`]:[])].join('\n');
  console.warn('[WorkflowAction] '+details);
  useUIStore.getState().showToast(`${context.action} · ${context.workflowName || context.workflowId || 'Workflow'}: ${message}`,
    'error',8000,true,details,undefined,undefined,undefined,undefined,details);
}
