import notedTerminalOriginal from '../assets/workflow-icons/original/noted-terminal-original.b64?raw';
import gtEditorOriginal from '../assets/workflow-icons/original/gt-editor-original.b64?raw';
import agrofieldOriginal from '../assets/workflow-icons/original/agrofield-original.b64?raw';
import scDesktopOriginal from '../assets/workflow-icons/original/sc-desktop-original.b64?raw';
import flowTabOriginal from '../assets/workflow-icons/original/flow-tab-original.b64?raw';
import voiceRecordOriginal from '../assets/workflow-icons/original/voice-record-original.b64?raw';
import iosDevOriginal from '../assets/workflow-icons/original/ios-dev-original.b64?raw';

export type WorkflowIconPreset = {
  key: string;
  projectPaths: string[];
  projectNames: string[];
  workflowNames: string[];
  canonicalWorkflowName: string;
  ensureWorkflow?: boolean;
  workflowIcon: string;
  projectIcon: string;
};

/** Точные цветные 64×64 PNG, снятые из production project metadata ДО первой
 * workflow-миграции. Workflow и project хранят исходное изображение без
 * display-фильтров и destructive rewrite. */
const pngDataUrl = (base64: string) => `data:image/png;base64,${base64.trim()}`;

export const WORKFLOW_ICON_PRESETS: WorkflowIconPreset[] = [
  {
    key: 'noted-terminal',
    projectPaths: ['/Users/fedor/Desktop/custom-terminal'],
    projectNames: ['custom-terminal'],
    workflowNames: ['main'],
    canonicalWorkflowName: 'main',
    workflowIcon: pngDataUrl(notedTerminalOriginal),
    projectIcon: pngDataUrl(notedTerminalOriginal),
  },
  {
    key: 'gt-editor',
    projectPaths: ['/Users/fedor/Desktop/gt-editor'],
    projectNames: ['gt-editor'],
    workflowNames: ['gt-editor'],
    canonicalWorkflowName: 'gt-editor',
    ensureWorkflow: true,
    workflowIcon: pngDataUrl(gtEditorOriginal),
    projectIcon: pngDataUrl(gtEditorOriginal),
  },
  {
    key: 'agrofield',
    projectPaths: ['/Users/fedor/Desktop/vs-code/agrotech/uav'],
    projectNames: ['agrotech', 'uav'],
    workflowNames: ['uav repo', 'uav-repo', 'uav репо'],
    canonicalWorkflowName: 'uav repo',
    workflowIcon: pngDataUrl(agrofieldOriginal),
    projectIcon: pngDataUrl(agrofieldOriginal),
  },
  {
    key: 'sc-desktop',
    projectPaths: ['/Users/fedor/Desktop/sc-desktop'],
    projectNames: ['sc-desktop'],
    workflowNames: ['sc-desk', 'sc desk', 'sc-test', 'sc test'],
    canonicalWorkflowName: 'sc-desk',
    workflowIcon: pngDataUrl(scDesktopOriginal),
    projectIcon: pngDataUrl(scDesktopOriginal),
  },
  {
    key: 'flow-tab',
    projectPaths: ['/Users/fedor/Desktop/hh-tool'],
    projectNames: ['hh-tool', 'flow-tab'],
    workflowNames: ['flow-tab', 'flow tab'],
    canonicalWorkflowName: 'flow-tab',
    workflowIcon: pngDataUrl(flowTabOriginal),
    projectIcon: pngDataUrl(flowTabOriginal),
  },
  {
    key: 'voice-record',
    projectPaths: ['/Users/fedor/Desktop/voice-record'],
    projectNames: ['mac-electron', 'voice-record'],
    workflowNames: ['voice', 'voice-record', 'mac-electron'],
    canonicalWorkflowName: 'mac-electron',
    ensureWorkflow: true,
    workflowIcon: pngDataUrl(voiceRecordOriginal),
    projectIcon: pngDataUrl(voiceRecordOriginal),
  },
  {
    key: 'ios-dev',
    projectPaths: ['/Users/fedor/Desktop/vs-code/habit-tracker'],
    projectNames: ['main-ios-app', 'habit-tracker'],
    workflowNames: ['ios-dev', 'ios dev'],
    canonicalWorkflowName: 'ios-dev',
    workflowIcon: pngDataUrl(iosDevOriginal),
    projectIcon: pngDataUrl(iosDevOriginal),
  },
];
