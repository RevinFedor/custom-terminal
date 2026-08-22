import notedTerminalColorSvg from '../assets/workflow-icons/noted-terminal-color.svg?raw';
import notedTerminalProjectSvg from '../assets/workflow-icons/noted-terminal-project.svg?raw';
import gtEditorColorSvg from '../assets/workflow-icons/gt-editor-color.svg?raw';
import gtEditorProjectSvg from '../assets/workflow-icons/gt-editor-project.svg?raw';
import agrofieldColorSvg from '../assets/workflow-icons/agrofield-color.svg?raw';
import agrofieldProjectSvg from '../assets/workflow-icons/agrofield-project.svg?raw';
import scDesktopColorSvg from '../assets/workflow-icons/sc-desktop-color.svg?raw';
import scDesktopProjectSvg from '../assets/workflow-icons/sc-desktop-project.svg?raw';
import flowTabColorSvg from '../assets/workflow-icons/flow-tab-color.svg?raw';
import flowTabProjectSvg from '../assets/workflow-icons/flow-tab-project.svg?raw';
import voiceRecordColorSvg from '../assets/workflow-icons/voice-record-color.svg?raw';
import voiceRecordProjectSvg from '../assets/workflow-icons/voice-record-project.svg?raw';
import iosDevColorSvg from '../assets/workflow-icons/ios-dev-color.svg?raw';
import iosDevProjectSvg from '../assets/workflow-icons/ios-dev-project.svg?raw';

export type WorkflowIconPreset = {
  key: string;
  projectPaths: string[];
  projectNames: string[];
  workflowNames: string[];
  workflowIcon: string;
  projectIcon: string;
};

/** SVG остаётся SVG в project/workflow metadata; IconCropper растрирует только
 * последующие ручные пользовательские загрузки. Так исходник не теряется уже в
 * самой one-shot migration и маленькая иконка остаётся резкой на Retina. */
const svgDataUrl = (source: string) => (
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source.trim())}`
);

export const WORKFLOW_ICON_PRESETS: WorkflowIconPreset[] = [
  {
    key: 'noted-terminal',
    projectPaths: ['/Users/fedor/Desktop/custom-terminal'],
    projectNames: ['custom-terminal'],
    workflowNames: ['main'],
    workflowIcon: svgDataUrl(notedTerminalColorSvg),
    projectIcon: svgDataUrl(notedTerminalProjectSvg),
  },
  {
    key: 'gt-editor',
    projectPaths: ['/Users/fedor/Desktop/gt-editor'],
    projectNames: ['gt-editor'],
    workflowNames: [],
    workflowIcon: svgDataUrl(gtEditorColorSvg),
    projectIcon: svgDataUrl(gtEditorProjectSvg),
  },
  {
    key: 'agrofield',
    projectPaths: ['/Users/fedor/Desktop/vs-code/agrotech/uav'],
    projectNames: ['agrotech', 'uav'],
    workflowNames: ['uav repo', 'uav-repo'],
    workflowIcon: svgDataUrl(agrofieldColorSvg),
    projectIcon: svgDataUrl(agrofieldProjectSvg),
  },
  {
    key: 'sc-desktop',
    projectPaths: ['/Users/fedor/Desktop/sc-desktop'],
    projectNames: ['sc-desktop'],
    workflowNames: ['sc-desk', 'sc desk', 'sc-test', 'sc test'],
    workflowIcon: svgDataUrl(scDesktopColorSvg),
    projectIcon: svgDataUrl(scDesktopProjectSvg),
  },
  {
    key: 'flow-tab',
    projectPaths: ['/Users/fedor/Desktop/hh-tool'],
    projectNames: ['hh-tool', 'flow-tab'],
    workflowNames: ['flow-tab', 'flow tab'],
    workflowIcon: svgDataUrl(flowTabColorSvg),
    projectIcon: svgDataUrl(flowTabProjectSvg),
  },
  {
    key: 'voice-record',
    projectPaths: ['/Users/fedor/Desktop/voice-record'],
    projectNames: ['mac-electron', 'voice-record'],
    workflowNames: ['voice', 'voice-record', 'mac-electron'],
    workflowIcon: svgDataUrl(voiceRecordColorSvg),
    projectIcon: svgDataUrl(voiceRecordProjectSvg),
  },
  {
    key: 'ios-dev',
    projectPaths: ['/Users/fedor/Desktop/vs-code/habit-tracker'],
    projectNames: ['main-ios-app', 'habit-tracker'],
    workflowNames: ['ios-dev', 'ios dev'],
    workflowIcon: svgDataUrl(iosDevColorSvg),
    projectIcon: svgDataUrl(iosDevProjectSvg),
  },
];

